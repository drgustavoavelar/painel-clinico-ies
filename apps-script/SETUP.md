# Setup — Painel Clínico IES · Automação Google Apps Script

Tempo estimado: **10 minutos**. Roda nos servidores do Google — Mac pode estar desligado.

---

## O que este script faz

```
Funcionária preenche o Google Form "Acompanhamento Dr. Gustavo"
  (campo "Paciente" + anexa o(s) PDF(s), Tipo de pedido = Exames)
       ↓ (a cada 5 min, automático)
  Script lê a planilha de respostas do formulário
       ↓
  Agrupa por paciente (usa o campo "Paciente", não o nome do arquivo)
       ↓
  Claude API analisa todos os documentos daquele paciente JUNTOS
       ↓
  JSON + resumo salvos no Drive · Notion atualizado · E-mail enviado
       ↓
  Linha da planilha marcada como analisada (não reprocessa de novo)
```

**Por que não usar o nome do arquivo para identificar o paciente:** os uploads do
Google Forms são renomeados automaticamente com o nome de quem *enviou* o
formulário (a funcionária), não do paciente — várias pacientes diferentes podem
ter arquivos com a mesma "segunda parte" do nome. O campo de texto "Paciente"
da planilha é a única fonte confiável.

---

## Passo 1 — Abrir o Apps Script

1. Acesse [script.google.com](https://script.google.com) (já logado na conta do Workspace)
2. Clique em **"+ Novo projeto"**
3. Renomeie o projeto: clique no título "Projeto sem título" → **"Painel Clínico IES"**
4. Apague o conteúdo da aba `Código.gs`
5. Copie todo o conteúdo do arquivo `painel-auto.gs` e cole

---

## Passo 2 — Configurar as chaves secretas

> As chaves nunca ficam no código — ficam nas Propriedades do Script (criptografadas pelo Google).

1. No menu lateral, clique no ícone de engrenagem ⚙️ → **"Configurações do projeto"**
2. Role até **"Propriedades do script"** → clique em **"Adicionar propriedade"**
3. Adicione as duas propriedades:

| Nome da propriedade | Valor |
|---|---|
| `ANTHROPIC_API_KEY` | Cole sua chave `sk-ant-api03-...` |
| `NOTION_API_KEY` | Cole o token `secret_ntn_...` da integração "Painel IES" |

4. Clique em **"Salvar propriedades do script"**

---

## Passo 3 — Conferir a planilha de respostas

O script já vem configurado para ler a planilha do formulário "Acompanhamento
Dr. Gustavo":

```javascript
SPREADSHEET_ID: '1suyX2U99lP2Qs0leqdtRFdqFfkMLSs8ECKB9uP2w7z4',
SHEET_GID:      584818370,
```

Se um dia o formulário mudar de planilha (ex.: recriado do zero), pegue o novo
ID e gid assim: abra o Google Form → aba **Respostas** → ícone verde do Sheets
→ a URL da planilha aberta tem o formato
`.../spreadsheets/d/SPREADSHEET_ID/edit#gid=SHEET_GID`.

O script também espera estas colunas na planilha (nomes exatos das perguntas do
formulário):

| Coluna | Uso |
|---|---|
| `Paciente` | Nome do paciente — usado para agrupar exames da mesma pessoa |
| `Tipo de pedido` | Só processa linhas com valor `Exames` |
| `Anexos` | Link(s) do(s) PDF(s) enviados |
| `Analisado pela IA` | **Criada automaticamente** pelo script na primeira execução — não mexa nela manualmente, exceto para apagar o conteúdo de uma linha e forçar reprocessamento |

---

## Passo 4 — Instalar o trigger (1 vez)

1. No editor, no menu suspenso de funções (topo, ao lado do ▶️), selecione **`instalarTrigger`**
2. Clique em **▶️ Executar**
3. Na primeira vez, o Google pedirá permissão para:
   - Acessar seus arquivos no Google Drive e Planilhas
   - Enviar e-mails em seu nome
   - Conectar a serviços externos (Claude API, Notion)
4. Clique em **"Revisar permissões"** → sua conta Google Workspace → **"Permitir"**
5. Confira no log (painel inferior): deve aparecer:
   ```
   ✅ Trigger instalado: processarExames a cada 5 minutos.
   ✅ Pasta de saída do Drive criada/verificada.
   ```

---

## Passo 5 — Teste

1. Preencha o formulário "Acompanhamento Dr. Gustavo" com um paciente de teste,
   `Tipo de pedido = Exames`, e anexe um PDF de exame
2. No editor do Apps Script, selecione a função **`testeManual`** e clique **▶️ Executar**
3. Aguarde ~30 segundos
4. Confira:
   - Log no editor: deve mostrar o processamento
   - Pasta `IES · Exames Processados` no Drive: JSON + resumo `.txt` criados
   - Notion: paciente criado/atualizado
   - E-mail em `dr.gustavoavelar@gmail.com` com o resumo
   - Na planilha de respostas: a coluna `Analisado pela IA` da linha de teste
     preenchida com a data/hora

---

## Uso no dia a dia

Nada muda no fluxo das suas funcionárias — elas continuam preenchendo o mesmo
formulário de sempre. A única regra nova: **usar `Tipo de pedido = Exames`**
quando o anexo for um exame para análise clínica (outros tipos como
Agendamentos/Dúvidas/Atestados são ignorados pela automação).

```
Funcionária recebe exame do paciente
   → Preenche o formulário "Acompanhamento Dr. Gustavo" (já faz isso hoje)
   → Campo Paciente = nome completo · Tipo de pedido = Exames · anexa o PDF
   → Em até 5 minutos: e-mail chega com a análise completa
   → Copie o JSON do e-mail ou do Drive → cole no painel:
     https://drgustavoavelar.github.io/painel-clinico-ies/
```

### Vários exames do mesmo paciente na mesma rodada

Se a funcionária (ou você) enviar mais de uma resposta do formulário para o
mesmo paciente antes da próxima rodada de 5 minutos (ex.: histórico + hemograma
+ ultrassom em respostas separadas), o script agrupa tudo automaticamente pelo
campo "Paciente" e manda **todos os documentos juntos** numa única chamada ao
Claude — assim o histórico/anamnese serve de contexto e exames de datas
diferentes viram snapshots corretos e separados, em vez de análises
fragmentadas.

### Reprocessar uma linha

Se precisar forçar uma nova análise de uma resposta já processada, apague o
conteúdo da célula da coluna `Analisado pela IA` naquela linha e rode
`testeManual` (ou espere o próximo ciclo do trigger).

---

## Ajustes opcionais

### Trocar o modelo para o econômico (Haiku)

No script, linha `MODELO_CLAUDE`:
```javascript
MODELO_CLAUDE: 'claude-haiku-4-5-20251001',
```
Haiku = ~10× mais barato, análise um pouco menos detalhada.

### Trocar intervalo do trigger (5 min → 10 min)

No script, função `instalarTrigger`:
```javascript
.everyMinutes(10)  // era 5
```
Depois rode `instalarTrigger` novamente para recriar.

### Adicionar WhatsApp / notificação por outro meio

A variável `CONFIG.EMAIL_NOTIF` pode ser alterada para qualquer e-mail.
Para WhatsApp, seria necessário integrar o Twilio ou similar (adicionar uma chamada de API extra no script).

---

## Solução de problemas

| Sintoma | Causa provável | Solução |
|---|---|---|
| Trigger não aparece em Gatilhos | `instalarTrigger` não foi rodado | Rode a função manualmente |
| Erro `Propriedade "ANTHROPIC_API_KEY" não configurada` | Chave não salva | Revise o Passo 2 |
| Erro `Colunas esperadas não encontradas na planilha` | Nome de alguma pergunta do formulário mudou | Confirme que existem colunas exatamente chamadas `Paciente`, `Tipo de pedido` e `Anexos` |
| Erro `Aba com gid ... não encontrada` | `SHEET_GID` desatualizado (planilha recriada) | Pegue o novo gid na URL da planilha (Passo 3) e atualize `CONFIG.SHEET_GID` |
| Erro `Banco "Pacientes em Acompanhamento" não encontrado` | Integração sem acesso ao banco | No Notion: abra o banco → "Conectar à integração" → "Painel IES" |
| Erro `Claude API 401` | Chave Anthropic inválida ou expirada | Gere nova chave em console.anthropic.com |
| Linha marcada com `⚠️ ERRO: ...` na planilha | Erro no processamento daquela resposta | Veja a mensagem na própria célula; corrija a causa e apague a célula para reprocessar |
| E-mail não chega | MailApp sem permissão | Rode `instalarTrigger` de novo e autorize |

### Ver logs de execução

Apps Script → menu **Execuções** (ícone de lista) → clique em qualquer execução para ver o log.

---

## Segurança

- As chaves da API ficam nas **Propriedades do Script** (criptografadas pelo Google, nunca no código)
- O script roda sob sua conta Google Workspace — nenhum dado sai do seu ecossistema Google + Anthropic + Notion
- O PDF é enviado ao Claude API via HTTPS e não é retido após a análise (política da Anthropic)
- Os PDFs originais nunca são movidos ou apagados — ficam sempre no lugar de sempre, vinculados ao registro do formulário
- Para revogar: Apps Script → Configurações → apague as propriedades; Triggers → exclua o trigger
