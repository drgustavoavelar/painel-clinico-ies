// ═══════════════════════════════════════════════════════════════════════════════
// Painel Clínico IES — Automação Google Apps Script
// Instituto Elo de Saúde · Dr. Gustavo Avelar
//
// Funcionamento:
//   1. Um PDF de exame é colocado na pasta "IES · Exames para Analisar" no Drive
//   2. O script (rodando a cada 5 min nos servidores do Google) detecta o arquivo
//   3. Envia o PDF ao Claude API para análise clínica
//   4. Salva o JSON e o resumo em texto na pasta "IES · Exames Processados"
//   5. Cria ou atualiza o paciente no Notion "Pacientes em Acompanhamento"
//   6. Envia um e-mail com o resumo e link para o JSON
//   7. Move o PDF da entrada para processados
//
// Setup: veja SETUP.md nesta mesma pasta
// ═══════════════════════════════════════════════════════════════════════════════

// ── Configuração ─────────────────────────────────────────────────────────────
var CONFIG = {
  PASTA_ENTRADA:     'IES · Exames para Analisar',
  PASTA_PROCESSADOS: 'IES · Exames Processados',
  PASTA_ERROS:       'IES · Erros de Análise',
  NOTION_DB_NAME:    'Pacientes em Acompanhamento',
  EMAIL_NOTIF:       'dr.gustavoavelar@gmail.com',
  MODELO_CLAUDE:     'claude-sonnet-4-6',
  MAX_PDF_BYTES:     8 * 1024 * 1024,   // 8 MB — limite seguro para UrlFetchApp
};

// ── System prompt clínico (espelho do painel.py) ──────────────────────────────
var SYSTEM_PROMPT = 'Você é o assistente clínico do Dr. Gustavo Avelar, médico especializado em\n'
  + 'endocrinologia e nutrologia no Instituto Elo de Saúde (IES), Uruaçu/GO.\n\n'
  + 'Seu trabalho é interpretar exames laboratoriais e gerar dois produtos simultâneos:\n'
  + '1. Um resumo compacto em texto para o médico ler rapidamente.\n'
  + '2. O JSON estruturado para o Painel Clínico IES.\n\n'
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
  + '  "snapshots": [ { snapshot } ]\n'
  + '}\n\n'
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

// ── Claude API ────────────────────────────────────────────────────────────────
function callClaude_(base64Pdf, filename) {
  var apiKey = getApiKey_('ANTHROPIC_API_KEY');

  var payload = JSON.stringify({
    model: CONFIG.MODELO_CLAUDE,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: base64Pdf
          }
        },
        {
          type: 'text',
          text: 'Analise o exame laboratorial acima e gere a tabela de alterações + JSON para o Painel Clínico IES. Arquivo: ' + filename
        }
      ]
    }]
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
  var snap = snapshots.length > 0 ? snapshots[snapshots.length - 1] : {};
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

// ── Processamento de um arquivo ───────────────────────────────────────────────
function processFile_(file, outputFolder) {
  var filename = file.getName();
  Logger.log('→ Processando: ' + filename);

  var blob = file.getBlob();
  var bytes = blob.getBytes();

  if (bytes.length > CONFIG.MAX_PDF_BYTES) {
    throw new Error('Arquivo muito grande (' + Math.round(bytes.length / 1024 / 1024) + ' MB). Limite: 8 MB.');
  }

  var base64 = Utilities.base64Encode(bytes);
  var result = callClaude_(base64, filename);
  Logger.log('Análise concluída para: ' + filename);

  var patientData = extractJson_(result);
  if (!patientData) throw new Error('JSON não encontrado na resposta do Claude.');

  // Salvar arquivos no Drive
  var dateStr = Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'yyyy-MM-dd');
  var baseName = filename.replace(/\.pdf$/i, '');

  var jsonFile = outputFolder.createFile(
    baseName + '_analise_' + dateStr + '.json',
    JSON.stringify(patientData, null, 2),
    'application/json'
  );
  outputFolder.createFile(
    baseName + '_resumo_' + dateStr + '.txt',
    result,
    'text/plain'
  );

  // Atualizar Notion
  var notionResult = '(Notion ignorado)';
  try {
    notionResult = updateNotion_(patientData);
    Logger.log(notionResult);
  } catch (e) {
    notionResult = '⚠️ Erro Notion: ' + e.message;
    Logger.log(notionResult);
  }

  // Mover PDF de entrada → processados
  file.moveTo(outputFolder);

  return {
    patient:      patientData.name || filename,
    notionResult: notionResult,
    jsonUrl:      jsonFile.getUrl(),
    result:       result
  };
}

// ── Função principal — acionada pelo trigger ──────────────────────────────────
function processarExames() {
  var inputFolder  = getOrCreateFolder_(CONFIG.PASTA_ENTRADA);
  var outputFolder = getOrCreateFolder_(CONFIG.PASTA_PROCESSADOS);
  var errorFolder  = getOrCreateFolder_(CONFIG.PASTA_ERROS);

  var files = inputFolder.getFilesByType(MimeType.PDF);
  var processed = [];
  var errors    = [];

  while (files.hasNext()) {
    var file = files.next();
    try {
      var r = processFile_(file, outputFolder);
      processed.push(r);
    } catch (e) {
      Logger.log('❌ Erro em ' + file.getName() + ': ' + e.message);
      errors.push({ file: file.getName(), error: e.message });
      try { file.moveTo(errorFolder); } catch (_) {}
    }
  }

  if (processed.length === 0 && errors.length === 0) {
    Logger.log('Nenhum PDF novo na pasta de entrada.');
    return;
  }

  // Compor e-mail de notificação
  var subject = '[Painel IES] ' + processed.length + ' exame(s) analisado(s)';
  var body = '';

  if (processed.length > 0) {
    body += '✅ ' + processed.length + ' exame(s) processado(s):\n\n';
    for (var i = 0; i < processed.length; i++) {
      var p = processed[i];
      body += '─────────────────────────────\n';
      body += 'Paciente: ' + p.patient + '\n';
      body += p.notionResult + '\n\n';

      // Trecho do resumo
      var resumoMatch = p.result.match(/### Alterações encontradas([\s\S]*?)(?=```json|$)/);
      if (resumoMatch) body += resumoMatch[0].trim().substring(0, 800) + '\n\n';

      body += '📂 JSON salvo no Drive:\n' + p.jsonUrl + '\n\n';
    }
    body += '─────────────────────────────\n';
    body += '🖥️  Cole o JSON no painel:\nhttps://drgustavoavelar.github.io/painel-clinico-ies/\n\n';
    body += '📁 Todos os arquivos: https://drive.google.com/drive/folders/' + getOrCreateFolder_(CONFIG.PASTA_PROCESSADOS).getId() + '\n';
  }

  if (errors.length > 0) {
    body += '\n⚠️ ' + errors.length + ' erro(s):\n';
    for (var j = 0; j < errors.length; j++) {
      body += '• ' + errors[j].file + '\n  ' + errors[j].error + '\n';
    }
    body += '\nArquivos com erro movidos para: ' + CONFIG.PASTA_ERROS + '\n';
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

  // Cria as pastas do Drive na primeira execução
  getOrCreateFolder_(CONFIG.PASTA_ENTRADA);
  getOrCreateFolder_(CONFIG.PASTA_PROCESSADOS);
  getOrCreateFolder_(CONFIG.PASTA_ERROS);
  Logger.log('✅ Pastas do Drive criadas/verificadas.');
}

// ── Teste manual: analisa PDFs já salvos no Drive (sem mover arquivos) ────────
// Útil para testar antes de instalar o trigger.
function testeManual() {
  var inputFolder = getOrCreateFolder_(CONFIG.PASTA_ENTRADA);
  var files = inputFolder.getFilesByType(MimeType.PDF);
  if (!files.hasNext()) {
    Logger.log('Nenhum PDF encontrado em "' + CONFIG.PASTA_ENTRADA + '".');
    Logger.log('Coloque um PDF lá e rode esta função novamente.');
    return;
  }
  Logger.log('Iniciando teste — os arquivos serão processados e MOVIDOS para Processados.');
  processarExames();
}
