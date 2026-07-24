#!/usr/bin/env python3
"""
painel.py — Análise de exames para o Painel Clínico IES
Instituto Elo de Saúde · Dr. Gustavo Avelar

Uso:
  python3 painel.py exame.pdf
  python3 painel.py lab1.pdf lab2.pdf --paciente "Maria Silva"
  python3 painel.py exame.pdf --salvar resultado.json
  python3 painel.py exame.pdf --sem-notion   (pula atualização do Notion)
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
    for pkg in ("pdfplumber", "anthropic", "requests"):
        try:
            __import__(pkg)
        except ImportError:
            missing.append(pkg)
    if missing:
        print(f"\n❌  Dependências faltando. Instale com:\n\n    pip3 install {' '.join(missing)}\n")
        sys.exit(1)

# ── System prompt clínico ─────────────────────────────────────────────────────
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
(lista em uma linha)

```json
{ ... JSON completo aqui ... }
```

━━ REGRAS PARA O JSON ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Schema paciente novo:
{
  "patientId": "nome-sobrenome-kebab-case",
  "name": "Nome Completo",
  "prontuario": "número ou vazio",
  "info": "DN DD/MM/AAAA (XXa) · Sexo · contexto clínico 1 linha",
  "snapshots": [ { snapshot } ]
}

Schema do snapshot:
{
  "date": "AAAA-MM-DD",
  "label": "Coleta DD/MM/AAAA",
  "metrics": [
    { "key": "KEY", "label": "Nome", "value": 0.0, "unit": "unidade", "refLow": null, "refHigh": null }
  ],
  "findings": [
    { "group": "Grupo", "achado": "1-3 frases.", "hipotese": "1-3 frases.", "sugestao": "1-3 frases." }
  ],
  "sintese": ["bullet 1", "bullet 2"],
  "terapeutica": { "manipuladas": ["..."], "comercializadas": ["..."] }
}

Regras:
- refLow/refHigh: copie EXATAMENTE do laudo — nunca invente.
- Primeira avaliação: inclua TODOS os marcadores numéricos (baseline completo).
- Retorno: inclua só marcadores alterados + os já presentes no histórico.
- Grupos normais: finding único {"group":"Exames sem alteração","achado":"...normais.","hipotese":"","sugestao":"Manutenção de rotina."}
- Cada campo achado/hipotese/sugestao: máximo 3 frases.
- NÃO inclua "prontuario" nem "paciente" no snapshot.
- sintese: máximo 7 bullets, do mais para o menos urgente. Prefixe com ⚠️ os urgentes.

Keys canônicas: TSH, T4L, T3, T3L, ANTI_TPO, TRAB | FSH, LH, PROLACTINA, ESTRADIOL,
PROGESTERONA, TESTO_TOTAL, TESTO_LIVRE, DHT, SHBG | GLICEMIA, HBA1C, INSULINA, HOMA_IR |
COL_TOTAL, HDL, LDL, VLDL, TG, APOLIPOPROTEINA_A1, APOLIPOPROTEINA_B | HB, HT, LEUCOCITOS,
PLAQUETAS, RDW, PCR, VHS | VITD, B12, VITAMINA_B6, ACIDO_FOLICO, HOMOCISTEINA, PTH |
FERRITINA, FERRO, SAT_TRANSFERRINA, TRANSFERRINA | CREATININA, UREIA, TGO, TGP, GGT, FA,
PROTEINAS_TOTAIS, ALBUMINA | SODIO, POTASSIO, CALCIO, CALCIO_IONICO, MAGNESIO, ACIDO_URICO

Responda SEMPRE em português do Brasil. Tom técnico e conciso."""

# ── Notion ────────────────────────────────────────────────────────────────────
NOTION_API = "https://api.notion.com/v1"
NOTION_DB_NAME = "Pacientes em Acompanhamento"

def _notion_headers(token: str) -> dict:
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
    }

def _rich_text(text: str) -> list:
    if not text:
        return []
    return [{"text": {"content": text[:2000]}}]

def _find_database(token: str) -> str | None:
    """Busca o banco 'Pacientes em Acompanhamento' pelo nome via search API."""
    import requests
    resp = requests.post(
        f"{NOTION_API}/search",
        json={"query": NOTION_DB_NAME, "filter": {"value": "database", "property": "object"}},
        headers=_notion_headers(token),
        timeout=15,
    )
    if resp.status_code != 200:
        return None
    for db in resp.json().get("results", []):
        title_parts = db.get("title", [])
        title = "".join(t.get("plain_text", "") for t in title_parts)
        if NOTION_DB_NAME.lower() in title.lower():
            return db["id"]
    return None

def _find_patient(name: str, db_id: str, token: str) -> str | None:
    import requests
    first = name.split()[0]
    resp = requests.post(
        f"{NOTION_API}/databases/{db_id}/query",
        json={"filter": {"property": "Nome", "title": {"contains": first}}},
        headers=_notion_headers(token),
        timeout=15,
    )
    if resp.status_code != 200:
        return None
    name_lower = name.lower()
    for page in resp.json().get("results", []):
        title_parts = page.get("properties", {}).get("Nome", {}).get("title", [])
        page_name = "".join(t.get("plain_text", "") for t in title_parts).lower()
        if name_lower in page_name or page_name in name_lower:
            return page["id"]
    return None

def update_notion(patient: dict, token: str):
    import requests

    name = patient.get("name", "")
    if not name:
        print("⚠️   Notion: nome do paciente não encontrado no JSON — pulando.")
        return

    # Localizar o banco de dados pelo nome
    db_id = _find_database(token)
    if not db_id:
        print(f"⚠️   Notion: banco '{NOTION_DB_NAME}' não encontrado. Verifique se a integração 'Painel IES' tem acesso a ele.")
        return

    snapshots = patient.get("snapshots", [])
    snap = snapshots[-1] if snapshots else {}
    sintese = snap.get("sintese", [])
    date = snap.get("date", "")

    principais = "\n".join(sintese[:5])
    alertas = "\n".join(s for s in sintese if "⚠" in s)

    pendentes = []
    verbos = ("solicitar", "repetir", "complementar", "pedir", "encaminhar", "aguardar")
    for f in snap.get("findings", []):
        for frase in f.get("sugestao", "").split("."):
            if any(v in frase.lower() for v in verbos) and frase.strip():
                pendentes.append(frase.strip())
    pendentes_text = ". ".join(pendentes[:6])

    props = {
        "Principais alterações IA": {"rich_text": _rich_text(principais)},
    }
    if date:
        props["Último exame IA"] = {"date": {"start": date}}
    if alertas:
        props["Alertas IA"] = {"rich_text": _rich_text(alertas)}
    if pendentes_text:
        props["Exames pendentes"] = {"rich_text": _rich_text(pendentes_text)}

    page_id = _find_patient(name, db_id, token)

    if page_id:
        resp = requests.patch(
            f"{NOTION_API}/pages/{page_id}",
            json={"properties": props},
            headers=_notion_headers(token),
            timeout=15,
        )
        if resp.status_code == 200:
            print(f"✅  Notion atualizado: {name}")
        else:
            print(f"⚠️   Notion erro ao atualizar ({resp.status_code}): {resp.text[:200]}")
    else:
        props["Nome"] = {"title": [{"text": {"content": name}}]}
        props["Status"] = {"select": {"name": "Ativo"}}
        props["Observação curta"] = {"rich_text": _rich_text("Cadastro automático via painel.py")}
        resp = requests.post(
            f"{NOTION_API}/pages",
            json={"parent": {"database_id": db_id}, "properties": props},
            headers=_notion_headers(token),
            timeout=15,
        )
        if resp.status_code == 200:
            print(f"✅  Notion: novo paciente criado — {name}")
        else:
            print(f"⚠️   Notion erro ao criar ({resp.status_code}): {resp.text[:200]}")

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

# ── Chamada à API Claude ──────────────────────────────────────────────────────
def analyze(pdf_paths: list, patient_name: str, model: str) -> str:
    import anthropic

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("\n❌  ANTHROPIC_API_KEY não encontrada no .env\n")
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
            print(f"⚠️   Nenhum texto extraído de {p.name} (PDF escaneado?)")
        parts.append(f"=== {p.name} ===\n{text}")

    patient_line = f"Nome do paciente: {patient_name}\n\n" if patient_name else ""
    user_msg = (
        f"{patient_line}"
        f"Analise os exames abaixo e gere a tabela de alterações + JSON para o Painel Clínico IES.\n\n"
        + "\n\n".join(parts)
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

# ── Extrai JSON da resposta ───────────────────────────────────────────────────
def extract_json(result: str) -> dict | None:
    match = re.search(r"```json\n(.*?)```", result, re.DOTALL)
    if not match:
        return None
    try:
        return json.loads(match.group(1).strip())
    except json.JSONDecodeError as e:
        print(f"⚠️   JSON inválido: {e}")
        return None

# ── Salva JSON em arquivo ─────────────────────────────────────────────────────
def save_json_file(data: dict, path: str):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"💾  JSON salvo em: {path}")

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    check_deps()

    parser = argparse.ArgumentParser(
        description="Analisa exames e gera JSON para o Painel Clínico IES + atualiza Notion",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
exemplos:
  python3 painel.py exame.pdf
  python3 painel.py lab1.pdf lab2.pdf --paciente "Maria Silva"
  python3 painel.py exame.pdf --salvar resultado.json
  python3 painel.py exame.pdf --sem-notion
  python3 painel.py exame.pdf --modelo claude-haiku-4-5-20251001
        """,
    )
    parser.add_argument("pdfs", nargs="+", help="PDF(s) dos exames")
    parser.add_argument("--paciente", default=None, help="Nome do paciente")
    parser.add_argument("--salvar", default=None, help="Salvar JSON em arquivo (ex: resultado.json)")
    parser.add_argument("--sem-notion", action="store_true", help="Pular atualização do Notion")
    parser.add_argument(
        "--modelo",
        default="claude-sonnet-4-6",
        help="Modelo Claude (padrão: claude-sonnet-4-6 | barato: claude-haiku-4-5-20251001)",
    )
    args = parser.parse_args()

    # Análise
    result = analyze(args.pdfs, args.paciente, args.modelo)

    print(f"\n{'─'*60}\n")
    print(result)
    print(f"\n{'─'*60}")

    # Extrai JSON da resposta
    patient_data = extract_json(result)

    # Salva JSON em arquivo se pedido
    if args.salvar and patient_data:
        save_json_file(patient_data, args.salvar)
    elif args.salvar:
        print("⚠️   Não foi possível extrair o JSON para salvar.")

    # Atualiza Notion automaticamente
    if not args.sem_notion and patient_data:
        notion_token = os.environ.get("NOTION_API_KEY")
        if notion_token:
            print("📋  Atualizando Notion...")
            update_notion(patient_data, notion_token)
        else:
            print("ℹ️   NOTION_API_KEY não configurada — pulando Notion.")

if __name__ == "__main__":
    main()
