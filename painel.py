#!/usr/bin/env python3
"""
painel.py — Análise de exames para o Painel Clínico IES
Instituto Elo de Saúde · Dr. Gustavo Avelar

Uso:
  python3 painel.py exame.pdf
  python3 painel.py lab1.pdf lab2.pdf --paciente "Maria Silva"
  python3 painel.py exame.pdf --salvar resultado.json
"""

import sys
import os
import re
import json
import argparse
from pathlib import Path

# ── Carrega variáveis do .env se existir ─────────────────────────────────────
env_file = Path(__file__).parent / ".env"
if env_file.exists():
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, val = line.partition("=")
            os.environ.setdefault(key.strip(), val.strip())

# ── Verificação de dependências ───────────────────────────────────────────────
def check_deps():
    missing = []
    try:
        import pdfplumber  # noqa
    except ImportError:
        missing.append("pdfplumber")
    try:
        import anthropic  # noqa
    except ImportError:
        missing.append("anthropic")
    if missing:
        print(f"\n❌  Dependências faltando. Instale com:\n\n    pip3 install {' '.join(missing)}\n")
        sys.exit(1)

# ── System prompt (instrução clínica + schema) ────────────────────────────────
SYSTEM_PROMPT = """Você é o assistente clínico do Dr. Gustavo Avelar, médico especializado em
endocrinologia e nutrologia no Instituto Elo de Saúde (IES), Uruaçu/GO.

Seu trabalho é interpretar exames laboratoriais e gerar dois produtos simultâneos:
1. Um resumo compacto em texto para o médico ler rapidamente.
2. O JSON estruturado para o Painel Clínico IES.

━━ FORMATO DE SAÍDA OBRIGATÓRIO ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

### Alterações encontradas

| Grupo | Achado | Conduta |
|---|---|---|
| (apenas grupos com algo relevante) | (valor + referência) | (ação específica) |

### ⚠️ Alertas
- (só se houver achado que exige ação imediata; omitir seção inteira se não houver)

### Exames sem alteração relevante
(lista em uma linha: Hemograma, Tireoide, Função renal... etc.)

```json
{ ... JSON completo aqui ... }
```

━━ REGRAS PARA O JSON ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Schema paciente novo (primeira avaliação):**
{
  "patientId": "nome-sobrenome-em-kebab-case",
  "name": "Nome Completo",
  "prontuario": "número ou vazio",
  "info": "DN DD/MM/AAAA (XXa) · Sexo · peso kg / altura m / IMC X · contexto clínico",
  "snapshots": [ { snapshot } ]
}

**Schema do snapshot:**
{
  "date": "AAAA-MM-DD",
  "label": "Coleta DD/MM/AAAA",
  "metrics": [
    { "key": "KEY", "label": "Nome", "value": 0.0, "unit": "unidade", "refLow": null, "refHigh": null }
  ],
  "findings": [
    { "group": "Nome do grupo", "achado": "...", "hipotese": "...", "sugestao": "..." }
  ],
  "sintese": ["bullet 1", "bullet 2", "bullet 3"],
  "terapeutica": { "manipuladas": ["..."], "comercializadas": ["..."] }
}

**Regras:**
- refLow/refHigh: copie EXATAMENTE do laudo — nunca invente.
- value: número puro (sem unidade, sem texto).
- Primeira avaliação: inclua TODOS os marcadores numéricos do laudo (baseline).
- Retorno: inclua só marcadores alterados + os já monitorados antes.
- findings: só grupos com achado relevante. Grupos normais → finding único:
  {"group":"Exames sem alteração","achado":"Hemograma, tireoide, ferro — normais.","hipotese":"","sugestao":"Manutenção e monitoramento de rotina."}
- achado/hipotese/sugestao: máximo 3 frases cada. Sem repetição entre si.
- NÃO inclua "prontuario" nem "paciente" no snapshot (omitir por padrão para economizar tokens).
- sintese: máximo 7 bullets, do mais para o menos urgente.

**Keys canônicas (use sempre estas, nunca invente novas para os mesmos marcadores):**
TSH, T4L, T3, T3L, ANTI_TPO, TRAB | FSH, LH, PROLACTINA, ESTRADIOL, PROGESTERONA,
TESTO_TOTAL, TESTO_LIVRE, DHT, SHBG | GLICEMIA, HBA1C, INSULINA, HOMA_IR |
COL_TOTAL, HDL, LDL, VLDL, TG, APOLIPOPROTEINA_A1, APOLIPOPROTEINA_B |
HB, HT, LEUCOCITOS, PLAQUETAS, RDW, PCR, VHS |
VITD, B12, VITAMINA_B6, ACIDO_FOLICO, HOMOCISTEINA, PTH |
FERRITINA, FERRO, SAT_TRANSFERRINA, TRANSFERRINA |
CREATININA, UREIA, TGO, TGP, GGT, FA, PROTEINAS_TOTAIS, ALBUMINA |
SODIO, POTASSIO, CALCIO, CALCIO_IONICO, MAGNESIO, ACIDO_URICO

Responda SEMPRE em português do Brasil. Tom técnico e conciso."""

# ── Extração de texto dos PDFs ────────────────────────────────────────────────
def extract_pdf_text(pdf_path: str) -> str:
    import pdfplumber
    pages = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            text = page.extract_text()
            if text and text.strip():
                pages.append(text)
    return "\n\n".join(pages)

# ── Chamada à API ─────────────────────────────────────────────────────────────
def analyze(pdf_paths: list, patient_name: str, model: str) -> str:
    import anthropic

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("\n❌  Chave da API não encontrada.")
        print("    Adicione ANTHROPIC_API_KEY=sua_chave no arquivo .env\n")
        sys.exit(1)

    print("📄  Extraindo texto dos PDFs...")
    parts = []
    for path in pdf_paths:
        p = Path(path)
        if not p.exists():
            print(f"❌  Arquivo não encontrado: {path}")
            sys.exit(1)
        print(f"    → {p.name}")
        text = extract_pdf_text(str(p))
        if not text.strip():
            print(f"⚠️   Nenhum texto extraído de {p.name} — verifique se o PDF não é uma imagem escaneada.")
        parts.append(f"=== ARQUIVO: {p.name} ===\n{text}")

    combined = "\n\n".join(parts)
    patient_line = f"Nome do paciente: {patient_name}\n\n" if patient_name else ""
    user_msg = (
        f"{patient_line}"
        f"Analise os exames abaixo e gere a tabela de alterações + JSON para o Painel Clínico IES.\n\n"
        f"{combined}"
    )

    print(f"🤖  Analisando com {model}...")
    client = anthropic.Anthropic(api_key=api_key)
    response = client.messages.create(
        model=model,
        max_tokens=8000,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_msg}],
    )

    usage = response.usage
    print(f"✅  Tokens: {usage.input_tokens} entrada + {usage.output_tokens} saída")

    return response.content[0].text

# ── Salvar JSON extraído ──────────────────────────────────────────────────────
def save_json(result: str, output_path: str):
    match = re.search(r"```json\n(.*?)```", result, re.DOTALL)
    if not match:
        print("\n⚠️   JSON não encontrado na resposta — salve manualmente do output acima.")
        return
    json_text = match.group(1).strip()
    try:
        parsed = json.loads(json_text)
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(parsed, f, ensure_ascii=False, indent=2)
        print(f"\n💾  JSON salvo em: {output_path}")
    except json.JSONDecodeError as e:
        print(f"\n⚠️   JSON gerado é inválido: {e}")
        print("     Copie manualmente o bloco ```json``` do output acima.")

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    check_deps()

    parser = argparse.ArgumentParser(
        description="Analisa exames laboratoriais e gera JSON para o Painel Clínico IES",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
exemplos:
  python3 painel.py exame.pdf
  python3 painel.py lab1.pdf lab2.pdf --paciente "Maria Silva"
  python3 painel.py exame.pdf --salvar resultado.json
  python3 painel.py exame.pdf --modelo claude-haiku-4-5-20251001   # mais barato
        """,
    )
    parser.add_argument("pdfs", nargs="+", help="PDF(s) dos exames (um ou mais arquivos)")
    parser.add_argument("--paciente", default=None, help="Nome do paciente (opcional)")
    parser.add_argument("--salvar", default=None, help="Salvar o JSON em arquivo (ex: resultado.json)")
    parser.add_argument(
        "--modelo",
        default="claude-sonnet-4-6",
        help="Modelo Claude a usar (padrão: claude-sonnet-4-6 | barato: claude-haiku-4-5-20251001)",
    )
    args = parser.parse_args()

    result = analyze(args.pdfs, args.paciente, args.modelo)

    sep = "─" * 60
    print(f"\n{sep}\n")
    print(result)
    print(f"\n{sep}")

    if args.salvar:
        save_json(result, args.salvar)

if __name__ == "__main__":
    main()
