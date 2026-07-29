// ═══════════════════════════════════════════════════════════════════════════════
// Painel Clínico IES — Automação Google Apps Script
// Instituto Elo de Saúde · Dr. Gustavo Avelar
//
// Funcionamento:
//   Existem DUAS formas de um exame entrar na automação — o script cobre as duas:
//
//   A) Via Google Form "Acompanhamento Dr. Gustavo": funcionária preenche o
//      campo "Paciente" (texto confiável) + anexa o(s) PDF(s). O script lê a
//      planilha de respostas e agrupa por esse campo.
//
//   B) Anexo direto na pasta "Anexos (File responses)" (mesma pasta do Form),
//      seguindo o POP de nomenclatura do Instituto Elo de Saúde:
//      "Exames_Nome_Sobrenome_Mes_Ano.pdf". O script varre a pasta, ignora
//      qualquer arquivo já referenciado por uma linha da planilha (evita
//      processar o mesmo exame duas vezes) e extrai o nome do paciente do
//      próprio nome do arquivo — só quando ele segue o padrão do POP.
//      Arquivos com nome fora do padrão são ignorados e listados no e-mail
//      para a equipe corrigir, nunca adivinhados.
//
//   Pontos em comum às duas formas:
//   - Agrupa por PACIENTE (campo do formulário OU nome do arquivo via POP,
//     nunca o nome bruto do arquivo do upload do Forms — esse traz o nome de
//     quem enviou, não do paciente, e não é confiável para identificação).
//     Se o mesmo paciente tiver arquivos vindos das duas formas na mesma
//     rodada, tudo é agrupado e enviado junto ao Claude.
//   - Documentos sem valores numéricos (histórico, anamnese, prontuário) viram
//     só contexto clínico — nunca um snapshot. Exames com datas de coleta
//     diferentes viram snapshots SEPARADOS (um por data), preservando a
//     comparação temporal correta.
//   - Salva UM JSON + resumo por paciente na pasta "IES · Exames Processados"
//     (os PDFs originais NÃO são movidos nem renomeados — continuam no lugar
//     de sempre; o controle de "já processado" fica interno ao script).
//   - Cria ou atualiza o paciente no Notion "Pacientes em Acompanhamento"
//     (uma única atualização por paciente, usando a data mais recente).
//   - Envia um e-mail consolidado (um bloco por paciente, não por arquivo).
//
// Setup: veja SETUP.md nesta mesma pasta
// ═══════════════════════════════════════════════════════════════════════════════

// ── Configuração ─────────────────────────────────────────────────────────────
var CONFIG = {
  SPREADSHEET_ID:      '1suyX2U99lP2Qs0leqdtRFdqFfkMLSs8ECKB9uP2w7z4', // Respostas do Form "Acompanhamento Dr. Gustavo"
  SHEET_GID:           584818370, // aba (tab) exata das respostas
  COL_PACIENTE:        'Paciente',
  COL_TIPO_PEDIDO:     'Tipo de pedido',
  COL_ANEXOS:          'Anexos',
  TIPO_PEDIDO_EXAME:   'Exames',
  COL_STATUS_IA:       'Analisado pela IA', // criada automaticamente se não existir
  ANEXOS_FOLDER_ID:    '18zJv7x8HpYOOksy_Mbwa9dFQdWL0fC9XV8RRhWonPSd1mbJ1ezFU26paINrK0E3J869bR88z', // pasta "Anexos (File responses)" — mesma do Form
  PASTA_PROCESSADOS:   'IES · Exames Processados',
  NOTION_DB_NAME:      'Pacientes em Acompanhamento',
  EMAIL_NOTIF:         'dr.gustavoavelar@gmail.com',
  MODELO_CLAUDE:       'claude-haiku-4-5-20251001',
  MAX_PDF_BYTES:       8 * 1024 * 1024,   // 8 MB — limite seguro para UrlFetchApp

  // ── Firestore (alimenta o painel automaticamente, sem colar JSON) ──────────
  FIRESTORE_PROJECT_ID: 'instituto-elo-de-saude',
  FIRESTORE_APP_ID:     'painel-clinico-ies-web', // mesmo appId usado no painel (index.html)
  FIRESTORE_UID:        'COLE_AQUI_O_UID_DO_FIREBASE_AUTH', // ver SETUP.md — "Passo 6"
};

// ── System prompt clínico (espelho do painel.py) ──────────────────────────────
var SYSTEM_PROMPT = 'Você é o assistente clínico do Dr. Gustavo Avelar, médico especializado em\n'
  + 'endocrinologia e nutrologia no Instituto Elo de Saúde (IES), Uruaçu/GO.\n\n'
  + 'Seu trabalho é interpretar exames laboratoriais e gerar dois produtos simultâneos:\n'
  + '1. Um resumo compacto em texto para o médico ler rapidamente.\n'
  + '2. O JSON estruturado para o Painel Clínico IES.\n\n'
  + '━━ MÚLTIPLOS DOCUMENTOS DO MESMO PACIENTE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n'
  + 'Você pode receber vários documentos de um mesmo paciente numa única mensagem\n'
  + '(ex.: histórico/anamnese + hemograma + ultrassom), enviados juntos de propósito\n'
  + 'para que você tenha o contexto clínico completo e gere hipóteses diagnósticas\n'
  + 'mais fidedignas — não são para analisar isoladamente.\n\n'
  + '- Documentos SEM valores numéricos (histórico, anamnese, prontuário, evolução\n'
  + '  de consulta) NUNCA viram um snapshot com métricas. Use-os apenas como\n'
  + '  contexto clínico para enriquecer "info", "hipotese" e "sugestao" — nunca\n'
  + '  invente marcadores a partir de texto narrativo.\n'
  + '- Se os documentos com valores numéricos tiverem DATAS DE COLETA diferentes\n'
  + '  entre si, gere um "snapshots" com uma entrada SEPARADA para cada data —\n'
  + '  nunca misture valores de datas diferentes num único snapshot.\n'
  + '- Se todos os exames numéricos forem da mesma data, gere um único snapshot\n'
  + '  combinando os marcadores de todos os documentos dessa data.\n\n'
  + '━━ FORMATO DE SAÍDA OBRIGATÓRIO ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n'
  + '### Alterações encontradas\n'
  + '| Grupo | Achado | Conduta |\n'
  + '|---|---|---|\n'
  + '| (apenas grupos com algo relevante) | (valor + referência) | (ação específica) |\n\n'
  + '### ⚠️ Alertas\n'
  + '- (só se houver achado que exige ação imediata; omitir seção inteira se não houver)\n\n'
  + '### Exames sem alteração relevante\n'
  + '(lista em uma linha)\n\n'
  + '```json\n'
  + '{ ... JSON completo aqui ... }\n'
  + '```\n\n'
  + '━━ REGRAS PARA O JSON ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n'
  + 'Schema paciente novo:\n'
  + '{\n'
  + '  "patientId": "nome-sobrenome-kebab-case",\n'
  + '  "name": "Nome Completo",\n'
  + '  "prontuario": "número ou vazio",\n'
  + '  "info": "DN DD/MM/AAAA (XXa) · Sexo · contexto clínico 1 linha",\n'
  + '  "snapshots": [ { snapshot }, { snapshot2 } ... ]\n'
  + '}\n\n'
  + '"snapshots" pode ter mais de um item nesta mesma resposta quando os\n'
  + 'documentos enviados juntos cobrem datas de coleta diferentes (ver seção\n'
  + 'acima sobre múltiplos documentos).\n\n'
  + 'Schema do snapshot:\n'
  + '{\n'
  + '  "date": "AAAA-MM-DD",\n'
  + '  "label": "Coleta DD/MM/AAAA",\n'
  + '  "metrics": [\n'
  + '    { "key": "KEY", "label": "Nome", "value": 0.0, "unit": "unidade", "refLow": null, "refHigh": null }\n'
  + '  ],\n'
  + '  "findings": [\n'
  + '    { "group": "Grupo", "achado": "1-3 frases.", "hipotese": "1-3 frases.", "sugestao": "1-3 frases." }\n'
  + '  ],\n'
  + '  "sintese": ["bullet 1", "bullet 2"],\n'
  + '  "terapeutica": { "manipuladas": ["..."], "comercializadas": ["..."] }\n'
  + '}\n\n'
  + 'Regras:\n'
  + '- refLow/refHigh: copie EXATAMENTE do laudo — nunca invente.\n'
  + '- Primeira avaliação: inclua TODOS os marcadores numéricos (baseline completo).\n'
  + '- Retorno: inclua só marcadores alterados + os já presentes no histórico.\n'
  + '- Grupos normais: finding único {"group":"Exames sem alteração","achado":"...normais.","hipotese":"","sugestao":"Manutenção de rotina."}\n'
  + '- Cada campo achado/hipotese/sugestao: máximo 3 frases.\n'
  + '- NÃO inclua "prontuario" nem "paciente" no snapshot.\n'
  + '- sintese: máximo 7 bullets, do mais para o menos urgente. Prefixe com ⚠️ os urgentes.\n\n'
  + 'Keys canônicas: TSH, T4L, T3, T3L, ANTI_TPO, TRAB | FSH, LH, PROLACTINA, ESTRADIOL,\n'
  + 'PROGESTERONA, TESTO_TOTAL, TESTO_LIVRE, DHT, SHBG | GLICEMIA, HBA1C, INSULINA, HOMA_IR |\n'
  + 'COL_TOTAL, HDL, LDL, VLDL, TG, APOLIPOPROTEINA_A1, APOLIPOPROTEINA_B | HB, HT, LEUCOCITOS,\n'
  + 'PLAQUETAS, RDW, PCR, VHS | VITD, B12, VITAMINA_B6, ACIDO_FOLICO, HOMOCISTEINA, PTH |\n'
  + 'FERRITINA, FERRO, SAT_TRANSFERRINA, TRANSFERRINA | CREATININA, UREIA, TGO, TGP, GGT, FA,\n'
  + 'PROTEINAS_TOTAIS, ALBUMINA | SODIO, POTASSIO, CALCIO, CALCIO_IONICO, MAGNESIO, ACIDO_URICO\n\n'
  + 'Responda SEMPRE em português do Brasil. Tom técnico e conciso.';

// ── Utilitários de Drive ──────────────────────────────────────────────────────
function getOrCreateFolder_(name) {
  var folders = DriveApp.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  var folder = DriveApp.createFolder(name);
  Logger.log('Pasta criada: ' + name + ' (' + folder.getUrl() + ')');
  return folder;
}

function getApiKey_(name) {
  var val = PropertiesService.getScriptProperties().getProperty(name);
  if (!val) throw new Error('Propriedade "' + name + '" não configurada. Vá em Projeto → Configurações → Propriedades do script.');
  return val;
}

// ── Leitura da planilha de respostas do Google Form ───────────────────────────
// Normaliza para agrupar variações do mesmo nome (acentos, maiúsculas,
// conectivos "de/da/do" que às vezes aparecem/somem entre uma resposta e outra).
function normalizePatientName_(name) {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(de|da|do|dos|das)\b/g, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getResponseSheet_() {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() === CONFIG.SHEET_GID) return sheets[i];
  }
  throw new Error('Aba com gid ' + CONFIG.SHEET_GID + ' não encontrada na planilha.');
}

function getHeaderMap_(sheet) {
  var headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var map = {};
  for (var i = 0; i < headerRow.length; i++) {
    if (headerRow[i]) map[headerRow[i].toString().trim()] = i; // índice 0-based
  }
  return map;
}

// Garante que a coluna de controle da IA existe; cria no final se não existir.
// Retorna o índice 0-based da coluna.
function ensureStatusColumn_(sheet, headerMap) {
  if (headerMap[CONFIG.COL_STATUS_IA] !== undefined) return headerMap[CONFIG.COL_STATUS_IA];
  var newColIndex = sheet.getLastColumn() + 1;
  sheet.getRange(1, newColIndex).setValue(CONFIG.COL_STATUS_IA);
  headerMap[CONFIG.COL_STATUS_IA] = newColIndex - 1;
  return newColIndex - 1;
}

// Extrai IDs de arquivo do Drive a partir do texto da célula "Anexos"
// (Forms grava como URLs separadas por vírgula/quebra de linha).
function extractDriveFileIds_(cellValue) {
  if (!cellValue) return [];
  var text = cellValue.toString();
  var ids = [];
  var patterns = [/\/d\/([a-zA-Z0-9_-]{15,})/g, /[?&]id=([a-zA-Z0-9_-]{15,})/g];
  patterns.forEach(function(re) {
    var m;
    while ((m = re.exec(text)) !== null) ids.push(m[1]);
  });
  // remove duplicatas (o mesmo link pode casar com os dois padrões)
  return ids.filter(function(id, idx) { return ids.indexOf(id) === idx; });
}

// Varre a planilha e agrupa por paciente as linhas ainda não analisadas
// (Tipo de pedido = Exames, coluna de status vazia, com anexos válidos).
function collectPendingPatientGroups_() {
  var sheet = getResponseSheet_();
  var headerMap = getHeaderMap_(sheet);
  var statusCol = ensureStatusColumn_(sheet, headerMap);

  var colPaciente = headerMap[CONFIG.COL_PACIENTE];
  var colTipo     = headerMap[CONFIG.COL_TIPO_PEDIDO];
  var colAnexos   = headerMap[CONFIG.COL_ANEXOS];
  if (colPaciente === undefined || colTipo === undefined || colAnexos === undefined) {
    throw new Error('Colunas esperadas não encontradas na planilha (Paciente/Tipo de pedido/Anexos).');
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { groups: {}, sheet: sheet, statusCol: statusCol, headerMap: headerMap };

  var data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  var groups = {}; // chave normalizada -> { displayName, files: [], rows: [] }

  for (var r = 0; r < data.length; r++) {
    var row = data[r];
    var rowNumber = r + 2; // linha real na planilha (1-based, +1 pelo cabeçalho)
    var jaAnalisado = row[statusCol];
    var tipoPedido = (row[colTipo] || '').toString().trim();
    if (jaAnalisado) continue;
    if (tipoPedido !== CONFIG.TIPO_PEDIDO_EXAME) continue;

    var pacienteNome = (row[colPaciente] || '').toString().trim();
    var fileIds = extractDriveFileIds_(row[colAnexos]);
    if (!pacienteNome || fileIds.length === 0) continue;

    var key = normalizePatientName_(pacienteNome);
    if (!groups[key]) groups[key] = { displayName: pacienteNome, files: [], rows: [] };
    groups[key].rows.push(rowNumber);
    fileIds.forEach(function(id) {
      try { groups[key].files.push(DriveApp.getFileById(id)); }
      catch (e) { Logger.log('⚠️ Não foi possível abrir arquivo ' + id + ' (linha ' + rowNumber + '): ' + e.message); }
    });
  }

  return { groups: groups, sheet: sheet, statusCol: statusCol, headerMap: headerMap };
}

function markRowsStatus_(sheet, statusCol, rowNumbers, statusText) {
  rowNumbers.forEach(function(rowNumber) {
    sheet.getRange(rowNumber, statusCol + 1).setValue(statusText);
  });
}

// ── Anexos diretos na pasta (fora do formulário) ──────────────────────────────
// Dois padrões de nome de arquivo são aceitos (ver extractPatientFromFilename_
// mais abaixo, que tenta os dois nessa ordem):
//   1. POP: "Exames_Nome_Sobrenome_Mes_Ano.pdf" (sem acentos)
//   2. Convenção antiga: "AAAA-MM-DD - Tipo do exame - Nome Completo.pdf"
// Qualquer outro formato é ignorado, nunca adivinhado.
var PREFIXOS_ARQUIVO_CONHECIDOS_ = ['exames', 'exame', 'resultado', 'resultados', 'laudo', 'laudos'];
var MESES_PT_ = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho',
                 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

// Extrai o nome do paciente de um arquivo salvo seguindo o POP. Retorna null
// se o nome do arquivo não seguir um padrão reconhecível — nesse caso o
// arquivo é ignorado (nunca adivinhado) e reportado no e-mail para a equipe
// corrigir o nome.
function extractPatientFromPOPFilename_(filename) {
  var base = filename.replace(/\.pdf$/i, '').trim();
  base = base.replace(/\s*\(\d+\)$/, ''); // remove sufixo de duplicata do Drive, ex: " (2)"
  var tokens = base.split('_').map(function(t) { return t.trim(); }).filter(Boolean);
  if (tokens.length === 0) return null;

  if (PREFIXOS_ARQUIVO_CONHECIDOS_.indexOf(tokens[0].toLowerCase()) >= 0) {
    tokens.shift();
  }
  if (tokens.length === 0) return null;

  // Mês e ano são OBRIGATÓRIOS para reconhecer o padrão do POP — sem os
  // dois, não há como confiar que o restante é mesmo o nome do paciente
  // (evita tratar arquivos como "lab_unimed_12345.pdf" como se "lab unimed"
  // fosse um paciente).
  var last = tokens[tokens.length - 1];
  if (!/^\d{4}$/.test(last)) return null; // ano obrigatório
  tokens.pop();
  if (tokens.length === 0) return null;

  var lastNorm = normalizePatientName_(tokens[tokens.length - 1]);
  if (MESES_PT_.indexOf(lastNorm) < 0) return null; // mês obrigatório
  tokens.pop();
  if (tokens.length === 0) return null;

  return tokens.join(' ');
}

// Segundo padrão aceito: "AAAA-MM-DD - Tipo do exame - Nome Completo.pdf"
// (convenção mais antiga, ainda usada para anexos soltos direto na pasta).
// Só reconhece se a DATA no início estiver presente — essa âncora é o que
// diferencia um arquivo assim de um upload do Google Forms, cujo nome vem
// como "<algo> - <Nome de quem enviou>.pdf" SEM data no início. Sem essa
// exigência, o último segmento poderia ser o nome de uma funcionária (ex.:
// "ANTONIO1_merged - Vitória Thalita Monteiro Medeiros.pdf") em vez do
// paciente — exatamente o erro que já causou confusão de pacientes antes.
function extractPatientFromDatePrefixedFilename_(filename) {
  var base = filename.replace(/\.pdf$/i, '').trim();
  base = base.replace(/\s*\(\d+\)$/, ''); // remove sufixo de duplicata do Drive
  var m = base.match(/^\d{4}-\d{2}-\d{2}\s*-\s*(.+)$/);
  if (!m) return null;
  var parts = m[1].split(' - ').map(function(s) { return s.trim(); }).filter(Boolean);
  if (parts.length === 0) return null;
  return parts[parts.length - 1];
}

// Tenta os dois padrões reconhecidos, nessa ordem. Retorna null (arquivo
// ignorado, nunca adivinhado) se nenhum dos dois casar.
function extractPatientFromFilename_(filename) {
  return extractPatientFromPOPFilename_(filename) || extractPatientFromDatePrefixedFilename_(filename);
}

// Todos os IDs de arquivo já referenciados por alguma linha da planilha —
// usado para não reprocessar pela varredura direta um arquivo que já veio
// (ou vai vir) pelo caminho do formulário.
function getFileIdsReferencedInSheet_(sheet, headerMap) {
  var ids = {};
  var colAnexos = headerMap[CONFIG.COL_ANEXOS];
  if (colAnexos === undefined) return ids;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return ids;
  var values = sheet.getRange(2, colAnexos + 1, lastRow - 1, 1).getValues();
  values.forEach(function(row) {
    extractDriveFileIds_(row[0]).forEach(function(id) { ids[id] = true; });
  });
  return ids;
}

// Controle de "já processado" para anexos diretos — não usa planilha nem
// move/renomeia o arquivo, só guarda o status internamente no script.
function isDirectFileProcessed_(fileId) {
  return PropertiesService.getScriptProperties().getProperty('DIRECT_' + fileId) !== null;
}
function markDirectFileStatus_(fileId, statusText) {
  PropertiesService.getScriptProperties().setProperty('DIRECT_' + fileId, statusText);
}

// Evita reenviar o aviso de "nome fora do padrão" a cada 5 minutos para o
// mesmo arquivo, para sempre — notifica uma vez, o médico decide quando agir.
function isIgnoredAlreadyNotified_(fileId) {
  return PropertiesService.getScriptProperties().getProperty('IGNORED_' + fileId) !== null;
}
function markIgnoredNotified_(fileId) {
  PropertiesService.getScriptProperties().setProperty('IGNORED_' + fileId, new Date().toISOString());
}

// Varre a pasta "Anexos (File responses)" e agrupa por paciente os PDFs que:
// (a) não vieram pelo formulário, (b) ainda não foram processados, e
// (c) têm nome de arquivo reconhecível (POP ou "Data - Tipo - Nome.pdf").
function collectPendingDirectDropGroups_(referencedIds) {
  var folder = DriveApp.getFolderById(CONFIG.ANEXOS_FOLDER_ID);
  var fileIterator = folder.getFilesByType(MimeType.PDF);
  var groups = {};
  var ignored = [];

  while (fileIterator.hasNext()) {
    var file = fileIterator.next();
    var id = file.getId();
    if (referencedIds[id]) continue;
    if (isDirectFileProcessed_(id)) continue;

    var patientName = extractPatientFromFilename_(file.getName());
    if (!patientName) {
      if (!isIgnoredAlreadyNotified_(id)) {
        ignored.push(file.getName());
        markIgnoredNotified_(id);
      }
      continue;
    }
    var key = normalizePatientName_(patientName);
    if (!groups[key]) groups[key] = { displayName: patientName, files: [], fileIds: [] };
    groups[key].files.push(file);
    groups[key].fileIds.push(id);
  }

  return { groups: groups, ignored: ignored };
}

// ── Claude API ────────────────────────────────────────────────────────────────
// Envia um ou mais PDFs do MESMO paciente numa única chamada, para que o
// Claude tenha o contexto completo (histórico + exames de datas diferentes).
function callClaudeMultiDoc_(files, displayName) {
  var apiKey = getApiKey_('ANTHROPIC_API_KEY');

  var content = [];
  var fileNames = [];
  for (var i = 0; i < files.length; i++) {
    var blob = files[i].getBlob();
    var bytes = blob.getBytes();
    if (bytes.length > CONFIG.MAX_PDF_BYTES) {
      throw new Error('Arquivo "' + files[i].getName() + '" muito grande (' +
        Math.round(bytes.length / 1024 / 1024) + ' MB). Limite: 8 MB por arquivo.');
    }
    content.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: Utilities.base64Encode(bytes) }
    });
    fileNames.push(files[i].getName());
  }

  var instructionText = files.length > 1
    ? 'Os ' + files.length + ' documentos acima são do mesmo paciente (' + displayName + '), enviados juntos ' +
      'de propósito para contextualizar a análise. Arquivos: ' + fileNames.join(' | ') + '. ' +
      'Gere a tabela de alterações + JSON consolidado para o Painel Clínico IES, seguindo as regras ' +
      'sobre múltiplos documentos e datas diferentes descritas nas instruções do sistema.'
    : 'Analise o exame acima e gere a tabela de alterações + JSON para o Painel Clínico IES. Arquivo: ' + fileNames[0];

  content.push({ type: 'text', text: instructionText });

  var payload = JSON.stringify({
    model: CONFIG.MODELO_CLAUDE,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: content }]
  });

  var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    payload: payload,
    muteHttpExceptions: true
  });

  var code = resp.getResponseCode();
  if (code !== 200) {
    throw new Error('Claude API ' + code + ': ' + resp.getContentText().substring(0, 300));
  }

  var body = JSON.parse(resp.getContentText());
  return body.content[0].text;
}

// ── Notion ────────────────────────────────────────────────────────────────────
function notionRequest_(method, path, body) {
  var token = getApiKey_('NOTION_API_KEY');
  var opts = {
    method: method,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    muteHttpExceptions: true
  };
  if (body) opts.payload = JSON.stringify(body);
  return UrlFetchApp.fetch('https://api.notion.com/v1' + path, opts);
}

function findNotionDatabase_() {
  var resp = notionRequest_('post', '/search', {
    query: CONFIG.NOTION_DB_NAME,
    filter: { value: 'database', property: 'object' }
  });
  var results = JSON.parse(resp.getContentText()).results || [];
  for (var i = 0; i < results.length; i++) {
    var db = results[i];
    var title = (db.title || []).map(function(t) { return t.plain_text; }).join('');
    if (title.toLowerCase().indexOf(CONFIG.NOTION_DB_NAME.toLowerCase()) >= 0) {
      return db.id;
    }
  }
  return null;
}

function findNotionPatient_(name, dbId) {
  var first = name.split(' ')[0];
  var resp = notionRequest_('post', '/databases/' + dbId + '/query', {
    filter: { property: 'Nome', title: { contains: first } }
  });
  var pages = JSON.parse(resp.getContentText()).results || [];
  var nameLower = name.toLowerCase();
  for (var i = 0; i < pages.length; i++) {
    var page = pages[i];
    var titleParts = (page.properties && page.properties['Nome'] && page.properties['Nome'].title) || [];
    var pageName = titleParts.map(function(t) { return t.plain_text; }).join('').toLowerCase();
    if (nameLower.indexOf(pageName) >= 0 || pageName.indexOf(nameLower) >= 0) return page.id;
  }
  return null;
}

function richText_(text) {
  if (!text) return [];
  return [{ text: { content: text.substring(0, 2000) } }];
}

function updateNotion_(patientData) {
  var name = patientData.name || '';
  if (!name) return '⚠️ Nome do paciente não encontrado no JSON';

  var dbId = findNotionDatabase_();
  if (!dbId) return '⚠️ Banco "' + CONFIG.NOTION_DB_NAME + '" não encontrado. Verifique se a integração tem acesso.';

  var snapshots = patientData.snapshots || [];
  // Ordena por data para garantir que pegamos o snapshot mais RECENTE —
  // importante quando a resposta traz vários snapshots (datas diferentes
  // enviadas juntas na mesma rodada), já que a ordem no array não é garantida.
  var sortedSnaps = snapshots.slice().sort(function(a, b) {
    return (a.date || '').localeCompare(b.date || '');
  });
  var snap = sortedSnaps.length > 0 ? sortedSnaps[sortedSnaps.length - 1] : {};
  var sintese = snap.sintese || [];
  var date = snap.date || '';

  var principais = sintese.slice(0, 5).join('\n');
  var alertas = sintese.filter(function(s) { return s.indexOf('⚠') >= 0; }).join('\n');

  var verbos = ['solicitar', 'repetir', 'complementar', 'pedir', 'encaminhar', 'aguardar'];
  var pendentes = [];
  var findings = snap.findings || [];
  for (var i = 0; i < findings.length; i++) {
    var sugestao = findings[i].sugestao || '';
    var frases = sugestao.split('.');
    for (var j = 0; j < frases.length; j++) {
      var frase = frases[j].trim();
      if (!frase) continue;
      var fraseLow = frase.toLowerCase();
      for (var k = 0; k < verbos.length; k++) {
        if (fraseLow.indexOf(verbos[k]) >= 0) { pendentes.push(frase); break; }
      }
    }
  }

  var props = {
    'Principais alterações IA': { rich_text: richText_(principais) }
  };
  if (date) props['Último exame IA'] = { date: { start: date } };
  if (alertas) props['Alertas IA'] = { rich_text: richText_(alertas) };
  if (pendentes.length) props['Exames pendentes'] = { rich_text: richText_(pendentes.slice(0, 6).join('. ')) };

  var pageId = findNotionPatient_(name, dbId);
  var resp;
  if (pageId) {
    resp = notionRequest_('patch', '/pages/' + pageId, { properties: props });
    if (resp.getResponseCode() === 200) return '✅ Notion atualizado: ' + name;
    return '⚠️ Notion erro ao atualizar (' + resp.getResponseCode() + '): ' + resp.getContentText().substring(0, 100);
  } else {
    props['Nome'] = { title: [{ text: { content: name } }] };
    props['Status'] = { select: { name: 'Ativo' } };
    props['Observação curta'] = { rich_text: richText_('Cadastro automático via Apps Script') };
    resp = notionRequest_('post', '/pages', {
      parent: { database_id: dbId },
      properties: props
    });
    if (resp.getResponseCode() === 200) return '✅ Notion: novo paciente criado — ' + name;
    return '⚠️ Notion erro ao criar (' + resp.getResponseCode() + '): ' + resp.getContentText().substring(0, 100);
  }
}

// ── Extração de JSON da resposta ──────────────────────────────────────────────
function extractJson_(text) {
  var match = text.match(/```json\n([\s\S]*?)```/);
  if (!match) return null;
  try {
    return JSON.parse(match[1].trim());
  } catch (e) {
    Logger.log('JSON inválido: ' + e.message);
    return null;
  }
}

// ── Firestore — alimenta o painel automaticamente, sem colar JSON ────────────
// Usa uma Service Account do Google Cloud (credencial "admin"), que
// ignora as regras de segurança do Firestore de propósito — o script roda
// só sob a conta do médico, então é a ponte confiável equivalente ao que o
// próprio painel faz quando ele está logado. Ver SETUP.md para como gerar
// as credenciais (GOOGLE_SA_CLIENT_EMAIL / GOOGLE_SA_PRIVATE_KEY).

function base64url_(strOrBytes) {
  var s = Utilities.base64EncodeWebSafe(strOrBytes);
  return s.replace(/=+$/, '');
}

// Troca a chave privada da Service Account por um token de acesso OAuth2
// (fluxo JWT-bearer), sem depender de bibliotecas externas.
function getFirestoreAccessToken_() {
  var clientEmail = getApiKey_('GOOGLE_SA_CLIENT_EMAIL');
  var privateKey = getApiKey_('GOOGLE_SA_PRIVATE_KEY').replace(/\\n/g, '\n');

  var header = { alg: 'RS256', typ: 'JWT' };
  var now = Math.floor(new Date().getTime() / 1000);
  var claimSet = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  var toSign = base64url_(JSON.stringify(header)) + '.' + base64url_(JSON.stringify(claimSet));
  var signatureBytes = Utilities.computeRsaSha256Signature(toSign, privateKey);
  var jwt = toSign + '.' + base64url_(signatureBytes);

  var resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    },
    muteHttpExceptions: true
  });
  var body = JSON.parse(resp.getContentText());
  if (!body.access_token) {
    throw new Error('Falha ao autenticar no Firestore: ' + resp.getContentText().substring(0, 300));
  }
  return body.access_token;
}

// Conversores entre objeto JS puro e o formato de campos tipados do Firestore.
function jsToFirestoreValue_(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(jsToFirestoreValue_) } };
  if (typeof v === 'object') {
    var fields = {};
    Object.keys(v).forEach(function(k) { fields[k] = jsToFirestoreValue_(v[k]); });
    return { mapValue: { fields: fields } };
  }
  return { stringValue: String(v) };
}
function firestoreValueToJs_(v) {
  if (!v || v.nullValue !== undefined) return null;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue, 10);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.arrayValue !== undefined) return (v.arrayValue.values || []).map(firestoreValueToJs_);
  if (v.mapValue !== undefined) {
    var obj = {};
    var f = v.mapValue.fields || {};
    Object.keys(f).forEach(function(k) { obj[k] = firestoreValueToJs_(f[k]); });
    return obj;
  }
  return null;
}

function firestoreDocUrl_(patientId) {
  var docPath = 'artifacts/' + CONFIG.FIRESTORE_APP_ID + '/users/' + CONFIG.FIRESTORE_UID + '/patients/' + patientId;
  return 'https://firestore.googleapis.com/v1/projects/' + CONFIG.FIRESTORE_PROJECT_ID + '/databases/(default)/documents/' + docPath;
}

function firestoreGetPatient_(patientId, token) {
  var resp = UrlFetchApp.fetch(firestoreDocUrl_(patientId), {
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) return null;
  var doc = JSON.parse(resp.getContentText());
  var obj = {};
  var f = doc.fields || {};
  Object.keys(f).forEach(function(k) { obj[k] = firestoreValueToJs_(f[k]); });
  return obj;
}

// Salva o paciente no Firestore, mesclando com snapshots já existentes (o
// Claude só gera o(s) snapshot(s) desta rodada — sem mesclar, um paciente já
// existente perderia o histórico anterior a cada nova análise).
function saveToFirestore_(patientData) {
  if (!CONFIG.FIRESTORE_UID || CONFIG.FIRESTORE_UID.indexOf('COLE_AQUI') === 0) {
    return '⚠️ Firestore não configurado (FIRESTORE_UID ausente) — painel não foi atualizado automaticamente';
  }

  var token = getFirestoreAccessToken_();
  var existing = firestoreGetPatient_(patientData.patientId, token);

  var merged;
  if (existing) {
    var snapMap = {};
    (existing.snapshots || []).forEach(function(s) { snapMap[s.date] = s; });
    (patientData.snapshots || []).forEach(function(s) { snapMap[s.date] = s; }); // novo substitui/soma
    var mergedSnapshots = Object.keys(snapMap).sort().map(function(d) { return snapMap[d]; });
    merged = {
      patientId: patientData.patientId,
      name: patientData.name || existing.name,
      prontuario: patientData.prontuario || existing.prontuario || '',
      info: patientData.info || existing.info || '',
      snapshots: mergedSnapshots
    };
  } else {
    merged = patientData;
  }

  var fields = {};
  Object.keys(merged).forEach(function(k) { fields[k] = jsToFirestoreValue_(merged[k]); });

  var resp = UrlFetchApp.fetch(firestoreDocUrl_(merged.patientId), {
    method: 'patch',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ fields: fields }),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) {
    throw new Error('Firestore erro (' + resp.getResponseCode() + '): ' + resp.getContentText().substring(0, 300));
  }

  return existing
    ? '✅ Painel atualizado automaticamente (' + mergedSnapshotsCount_(merged) + ' snapshot(s) no total)'
    : '✅ Painel: novo paciente criado automaticamente';
}
function mergedSnapshotsCount_(merged) {
  return (merged.snapshots || []).length;
}

// ── Processamento de um grupo de arquivos (todos do mesmo paciente) ───────────
function processPatientGroup_(displayName, files, outputFolder) {
  var fileNames = files.map(function(f) { return f.getName(); });
  Logger.log('→ Processando paciente "' + displayName + '" (' + files.length + ' arquivo(s)): ' + fileNames.join(', '));

  var result = callClaudeMultiDoc_(files, displayName);
  Logger.log('Análise concluída para: ' + displayName);

  var patientData = extractJson_(result);
  if (!patientData) throw new Error('JSON não encontrado na resposta do Claude.');

  // Salvar UM JSON + resumo por paciente (não por arquivo)
  var dateStr = Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'yyyy-MM-dd');
  var safeName = displayName.replace(/[\/\\:*?"<>|]/g, '').trim();

  var jsonFile = outputFolder.createFile(
    safeName + '_analise_' + dateStr + '.json',
    JSON.stringify(patientData, null, 2),
    'application/json'
  );
  outputFolder.createFile(
    safeName + '_resumo_' + dateStr + '.txt',
    result,
    'text/plain'
  );

  // Atualizar Notion — uma única vez por paciente
  var notionResult = '(Notion ignorado)';
  try {
    notionResult = updateNotion_(patientData);
    Logger.log(notionResult);
  } catch (e) {
    notionResult = '⚠️ Erro Notion: ' + e.message;
    Logger.log(notionResult);
  }

  // Atualizar o painel automaticamente via Firestore — sem colar JSON à mão
  var painelResult = '(Firestore ignorado)';
  try {
    painelResult = saveToFirestore_(patientData);
    Logger.log(painelResult);
  } catch (e) {
    painelResult = '⚠️ Erro ao atualizar o painel: ' + e.message;
    Logger.log(painelResult);
  }

  // Os PDFs originais NÃO são movidos — pertencem ao registro do formulário
  // (pasta "Anexos (File responses)") e não devem ser reorganizados aqui.

  return {
    patient:      patientData.name || displayName,
    fileCount:    files.length,
    fileNames:    fileNames,
    notionResult: notionResult,
    painelResult: painelResult,
    jsonUrl:      jsonFile.getUrl(),
    result:       result
  };
}

// ── Função principal — acionada pelo trigger ──────────────────────────────────
function processarExames() {
  var outputFolder = getOrCreateFolder_(CONFIG.PASTA_PROCESSADOS);

  // Fonte 1: planilha do formulário
  var pending = collectPendingPatientGroups_();
  var sheet = pending.sheet;
  var statusCol = pending.statusCol;

  // Fonte 2: anexos direto na pasta, ignorando o que já está referenciado
  // na planilha (evita processar o mesmo exame duas vezes)
  var referencedIds = getFileIdsReferencedInSheet_(sheet, pending.headerMap);
  var direct = collectPendingDirectDropGroups_(referencedIds);

  // Combina as duas fontes por paciente — se o mesmo paciente tiver arquivos
  // vindos do formulário E de anexo direto na mesma rodada, tudo é agrupado
  // e enviado junto ao Claude.
  var allGroups = {}; // chave normalizada -> { displayName, files, rows?, fileIds? }
  Object.keys(pending.groups).forEach(function(key) {
    var g = pending.groups[key];
    allGroups[key] = { displayName: g.displayName, files: g.files.slice(), rows: g.rows };
  });
  Object.keys(direct.groups).forEach(function(key) {
    var g = direct.groups[key];
    if (allGroups[key]) {
      allGroups[key].files = allGroups[key].files.concat(g.files);
      allGroups[key].fileIds = g.fileIds;
    } else {
      allGroups[key] = { displayName: g.displayName, files: g.files.slice(), fileIds: g.fileIds };
    }
  });

  var groupKeys = Object.keys(allGroups);
  if (groupKeys.length === 0 && direct.ignored.length === 0) {
    Logger.log('Nada pendente (nem planilha, nem anexos diretos).');
    return;
  }

  var processed = [];
  var errors    = [];

  for (var g = 0; g < groupKeys.length; g++) {
    var group = allGroups[groupKeys[g]];
    var agora = Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'dd/MM/yyyy HH:mm');
    try {
      var r = processPatientGroup_(group.displayName, group.files, outputFolder);
      processed.push(r);
      if (group.rows) markRowsStatus_(sheet, statusCol, group.rows, '✅ ' + agora);
      if (group.fileIds) group.fileIds.forEach(function(id) { markDirectFileStatus_(id, '✅ OK ' + agora); });
    } catch (e) {
      Logger.log('❌ Erro no paciente "' + group.displayName + '": ' + e.message);
      errors.push({ file: group.displayName, error: e.message });
      if (group.rows) markRowsStatus_(sheet, statusCol, group.rows, '⚠️ ERRO: ' + e.message.substring(0, 200));
      if (group.fileIds) group.fileIds.forEach(function(id) { markDirectFileStatus_(id, '⚠️ ERRO: ' + e.message.substring(0, 200) + ' ' + agora); });
    }
  }

  // Compor e-mail de notificação — um bloco por paciente, não por arquivo
  var subject = '[Painel IES] ' + processed.length + ' paciente(s) analisado(s)';
  var body = '';

  if (processed.length > 0) {
    body += '✅ ' + processed.length + ' paciente(s) processado(s):\n\n';
    for (var i = 0; i < processed.length; i++) {
      var p = processed[i];
      body += '─────────────────────────────\n';
      body += 'Paciente: ' + p.patient + '\n';
      body += 'Arquivos analisados juntos (' + p.fileCount + '): ' + p.fileNames.join(', ') + '\n';
      body += p.notionResult + '\n';
      body += p.painelResult + '\n\n';

      // Trecho do resumo
      var resumoMatch = p.result.match(/### Alterações encontradas([\s\S]*?)(?=```json|$)/);
      if (resumoMatch) body += resumoMatch[0].trim().substring(0, 800) + '\n\n';

      body += '📂 JSON salvo no Drive:\n' + p.jsonUrl + '\n\n';
    }
    body += '─────────────────────────────\n';
    body += '🖥️  Painel (já atualizado automaticamente): https://drgustavoavelar.github.io/painel-clinico-ies/\n';
    body += '   (se aparecer "⚠️ Erro ao atualizar o painel" em algum paciente acima, copie o JSON do Drive e cole manualmente como reserva)\n\n';
    body += '📁 Todos os arquivos: https://drive.google.com/drive/folders/' + getOrCreateFolder_(CONFIG.PASTA_PROCESSADOS).getId() + '\n';
  }

  if (errors.length > 0) {
    body += '\n⚠️ ' + errors.length + ' erro(s):\n';
    for (var j = 0; j < errors.length; j++) {
      body += '• ' + errors[j].file + '\n  ' + errors[j].error + '\n';
    }
    body += '\nLinha(s)/arquivo(s) marcados com erro — corrija a causa e apague a célula de status (planilha) ou peça para reprocessar (anexo direto).\n';
  }

  if (direct.ignored.length > 0) {
    body += '\n📎 ' + direct.ignored.length + ' arquivo(s) na pasta "Anexos" ignorado(s) por nome fora do padrão do POP:\n';
    direct.ignored.forEach(function(name) { body += '• ' + name + '\n'; });
    body += '\nRenomeie seguindo "Exames_Nome_Sobrenome_Mes_Ano.pdf" para que sejam processados na próxima rodada.\n';
  }

  MailApp.sendEmail({
    to:      CONFIG.EMAIL_NOTIF,
    subject: subject,
    body:    body
  });

  Logger.log('E-mail enviado para ' + CONFIG.EMAIL_NOTIF);
}

// ── Setup: instalar trigger automático ───────────────────────────────────────
// Execute esta função UMA VEZ manualmente para criar o agendamento de 5 minutos.
function instalarTrigger() {
  // Remove triggers antigos desta função para evitar duplicatas
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'processarExames') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('processarExames')
    .timeBased()
    .everyMinutes(5)
    .create();

  Logger.log('✅ Trigger instalado: processarExames a cada 5 minutos.');

  // Cria a pasta de saída na primeira execução (a entrada agora é a
  // planilha de respostas do Google Form, configurada em CONFIG.SPREADSHEET_ID)
  getOrCreateFolder_(CONFIG.PASTA_PROCESSADOS);
  Logger.log('✅ Pasta de saída do Drive criada/verificada.');
}

// ── Teste manual: processa a planilha de respostas agora mesmo ───────────────
// Útil para testar antes de instalar o trigger, ou para forçar uma rodada
// fora do agendamento de 5 minutos.
function testeManual() {
  Logger.log('Iniciando teste — lendo respostas pendentes da planilha do Google Form.');
  processarExames();
}
