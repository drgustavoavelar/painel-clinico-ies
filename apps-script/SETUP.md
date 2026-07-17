# Setup — Painel Clínico IES · Automação Google Apps Script

Tempo estimado: **10 minutos**. Roda nos servidores do Google — Mac pode estar desligado.

---

## O que este script faz

```
PDF na pasta do Drive
       ↓ (a cada 5 min, automático)
  Claude API analisa
       ↓
  JSON salvo no Drive
       ↓
  Notion atualizado
       ↓
  E-mail com resumo
```

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

## Passo 3 — Instalar o trigger (1 vez)

1. No editor, no menu suspenso de funções (topo, ao lado do ▶️), selecione **`instalarTrigger`**
2. Clique em **▶️ Executar**
3. Na primeira vez, o Google pedirá permissão para:
   - Acessar seus arquivos no Google Drive
   - Enviar e-mails em seu nome
   - Conectar a serviços externos (Claude API, Notion)
4. Clique em **"Revisar permissões"** → sua conta Google Workspace → **"Permitir"**
5. Confira no log (painel inferior): deve aparecer:
   ```
   ✅ Trigger instalado: processarExames a cada 5 minutos.
   ✅ Pastas do Drive criadas/verificadas.
   ```

---

## Passo 4 — Verificar as pastas no Drive

Após o passo 3, acesse o [Google Drive](https://drive.google.com) e confirme que estas pastas foram criadas na raiz:

- 📂 `IES · Exames para Analisar`   ← **aqui você vai soltar os PDFs**
- 📂 `IES · Exames Processados`     ← análises prontas ficam aqui
- 📂 `IES · Erros de Análise`       ← PDFs que falharam ficam aqui

> Dica: adicione "IES · Exames para Analisar" aos **Atalhos** do Drive para acesso rápido.

---

## Passo 5 — Teste

1. Coloque qualquer PDF de exame na pasta `IES · Exames para Analisar`
2. No editor do Apps Script, selecione a função **`testeManual`** e clique **▶️ Executar**
3. Aguarde ~30 segundos
4. Confira:
   - Log no editor: deve mostrar o processamento
   - Pasta `IES · Exames Processados`: JSON + resumo .txt criados
   - Notion: paciente criado/atualizado
   - E-mail em `dr.gustavoavelar@gmail.com` com o resumo

---

## Uso no dia a dia

Após a instalação, basta:

```
Recebeu exame do paciente?
   → Salve o PDF no iPhone/desktop
   → Arraste para "IES · Exames para Analisar" no Drive
   → Em até 5 minutos: e-mail chega com a análise completa
   → Copie o JSON do e-mail ou do Drive → cole no painel:
     https://drgustavoavelar.github.io/painel-clinico-ies/
```

No iPhone: use o app **Google Drive** → pasta de atalho → "Fazer upload".

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
| Erro `Banco "Pacientes em Acompanhamento" não encontrado` | Integração sem acesso ao banco | No Notion: abra o banco → "Conectar à integração" → "Painel IES" |
| Erro `Claude API 401` | Chave Anthropic inválida ou expirada | Gere nova chave em console.anthropic.com |
| PDF movido para "IES · Erros de Análise" | Erro no processamento | Verifique o log em Apps Script → Execuções |
| E-mail não chega | MailApp sem permissão | Rode `instalarTrigger` de novo e autorize |

### Ver logs de execução

Apps Script → menu **Execuções** (ícone de lista) → clique em qualquer execução para ver o log.

---

## Segurança

- As chaves da API ficam nas **Propriedades do Script** (criptografadas pelo Google, nunca no código)
- O script roda sob sua conta Google Workspace — nenhum dado sai do seu ecossistema Google + Anthropic + Notion
- O PDF é enviado ao Claude API via HTTPS e não é retido após a análise (política da Anthropic)
- Para revogar: Apps Script → Configurações → apague as propriedades; Triggers → exclua o trigger
