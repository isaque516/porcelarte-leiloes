// ============================================================
// ABADIAS x SODRE - Robo do Gmail (roda nos servidores Google)
// - Resultados: marca vendidos/nao vendidos com valores oficiais;
//   condicionais viram vendidos quando detecta SUA resposta "aprovado".
// - Prestacao de contas (Ricardo): BAIXA automatica (leilao PAGO + lotes pagos).
// - Nunca envia e-mail para a Sodre; so avisa VOCE por e-mail resumo.
// ============================================================
var FS_BASE = 'https://firestore.googleapis.com/v1/projects/porcelarte-leiloes/databases/(default)/documents';
var FS_KEY  = 'AIzaSyCk5wE8UUvUGOTjEGzEGecCBFjRd4Am0ro';

function rodarAgora() { main_(); }

function criarGatilho() {
  var ts = ScriptApp.getProjectTriggers();
  for (var i = 0; i < ts.length; i++) ScriptApp.deleteTrigger(ts[i]);
  ScriptApp.newTrigger('main_').timeBased().everyDays(1).atHour(10).create();
  ScriptApp.newTrigger('main_').timeBased().everyDays(1).atHour(16).create();
  if (false) { DriveApp.getStorageUsed(); } // garante escopo do Drive
  MailApp.sendEmail(Session.getActiveUser().getEmail(),
    'Abadias - robo do Gmail ativado',
    'Verificacao automatica ativada: todos os dias ~10h e ~16h.\nResultados e baixas da Sodre serao aplicados no Abadias sozinhos.');
}

// ---------- Firestore ----------
function fsGet_(path) {
  var r = UrlFetchApp.fetch(FS_BASE + '/' + path + '?key=' + FS_KEY, { muteHttpExceptions: true });
  return { code: r.getResponseCode(), json: r.getResponseCode() == 200 ? JSON.parse(r.getContentText()) : null };
}
function fsPatch_(path, fields, mask) {
  var url = FS_BASE + '/' + path + '?key=' + FS_KEY;
  if (mask) for (var i = 0; i < mask.length; i++) url += '&updateMask.fieldPaths=' + mask[i];
  var r = UrlFetchApp.fetch(url, { method: 'patch', contentType: 'application/json',
    payload: JSON.stringify({ fields: fields }), muteHttpExceptions: true });
  return r.getResponseCode() == 200;
}
function fsList_(col) {
  var out = [], tk = '';
  do {
    var u = FS_BASE + '/' + col + '?key=' + FS_KEY + '&pageSize=100' + (tk ? '&pageToken=' + tk : '');
    var j = JSON.parse(UrlFetchApp.fetch(u).getContentText());
    var ds = j.documents || [];
    for (var i = 0; i < ds.length; i++) out.push(ds[i]);
    tk = j.nextPageToken || '';
  } while (tk);
  return out;
}
function gv_(d, k) {
  var f = (d.fields || {})[k]; if (!f) return undefined;
  if (f.stringValue !== undefined) return f.stringValue;
  if (f.doubleValue !== undefined) return f.doubleValue;
  if (f.integerValue !== undefined) return Number(f.integerValue);
  if (f.booleanValue !== undefined) return f.booleanValue;
}
function S_(v) { return { stringValue: String(v) }; }
function D_(v) { return { doubleValue: Number(v) || 0 }; }
function B_(v) { return { booleanValue: !!v }; }

// ---------- Planilha xls -> linhas ----------
function xlsParaLinhas_(blob) {
  var boundary = 'xxABADIASxx';
  var meta = { name: 'abadias-tmp', mimeType: 'application/vnd.google-apps.spreadsheet' };
  var head = Utilities.newBlob('--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'
    + JSON.stringify(meta) + '\r\n--' + boundary + '\r\nContent-Type: application/vnd.ms-excel\r\n\r\n').getBytes();
  var tail = Utilities.newBlob('\r\n--' + boundary + '--').getBytes();
  var payload = head.concat(blob.getBytes()).concat(tail);
  var r = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'post', contentType: 'multipart/related; boundary=' + boundary, payload: payload,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } });
  var id = JSON.parse(r.getContentText()).id;
  var vals = SpreadsheetApp.openById(id).getSheets()[0].getDataRange().getValues();
  UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + id, {
    method: 'delete', headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  return vals;
}
function parseVenda_(v) {
  if (typeof v === 'number') return v;
  var s = String(v || '').replace(/[^0-9,\.]/g, '').replace(/\./g, '').replace(',', '.');
  return Number(s) || 0;
}

// ---------- Principal ----------
function main_() {
  var MEU = Session.getActiveUser().getEmail();
  var log = [];
  var lotes = fsList_('lotes');
  var porNum = {};
  for (var i = 0; i < lotes.length; i++) {
    var d = lotes[i];
    porNum[String(gv_(d, 'num'))] = { id: d.name.split('/').pop(), vendido: gv_(d, 'vendido') === true, pago: gv_(d, 'pago') === true };
  }
  var leiloes = fsList_('leiloes');

  // 1) RESULTADOS
  var ths = GmailApp.search('from:montagem@sodresantoro.com.br subject:resultado newer_than:14d');
  for (var t = 0; t < ths.length; t++) {
    var th = ths[t];
    var subj = th.getFirstMessageSubject();
    var m = subj.match(/(\d{5})/); if (!m) continue;
    var leilao = m[1];
    var st = fsGet_('emails_processados/resultado-' + leilao);
    var estado = st.json ? gv_(st.json, 'status') : '';
    if (estado === 'finalizado') continue;
    var msgs = th.getMessages();
    var aprovado = false, att = null;
    for (var k = 0; k < msgs.length; k++) {
      if (msgs[k].getFrom().indexOf(MEU) > -1 && /aprovad/i.test(msgs[k].getPlainBody())) aprovado = true;
      if (!att) { var as = msgs[k].getAttachments();
        for (var j = 0; j < as.length; j++) { if (/\.xls/i.test(as[j].getName())) { att = as[j]; break; } } }
    }
    if (!att) { log.push('Resultado ' + leilao + ': e-mail sem planilha anexa.'); continue; }
    var vals;
    try { vals = xlsParaLinhas_(att.copyBlob()); }
    catch (e) { log.push('Resultado ' + leilao + ': erro ao ler planilha (' + e + ')'); continue; }
    var hi = -1, cLote = -1, cSt = -1, cVenda = -1;
    for (var r0 = 0; r0 < Math.min(10, vals.length); r0++) {
      cLote = cSt = cVenda = -1;
      for (var c = 0; c < vals[r0].length; c++) {
        var h = String(vals[r0][c]).toLowerCase().replace(/\s+/g, ' ').trim();
        if (h === 'lote') cLote = c;
        if (h.indexOf('st.') === 0 || h.indexOf('st. lote') > -1) cSt = c;
        if (h.indexOf('venda') === 0) cVenda = c;
      }
      if (cLote > -1 && cSt > -1 && cVenda > -1) { hi = r0; break; }
    }
    if (hi < 0) { log.push('Resultado ' + leilao + ': formato da planilha mudou, nao apliquei.'); continue; }
    var vend = 0, tot = 0, conds = 0;
    for (var r1 = hi + 1; r1 < vals.length; r1++) {
      var lt = String(vals[r1][cLote] || '').replace(/\D/g, ''); if (!lt) continue;
      var num = leilao + '-' + ('000' + lt).slice(-3);
      var ex = porNum[num];
      if (!ex) { log.push('Aviso: lote ' + num + ' da planilha nao existe no app.'); continue; }
      if (ex.pago) continue;
      var stx = String(vals[r1][cSt] || '').toLowerCase();
      var vv = parseVenda_(vals[r1][cVenda]);
      var fields = null;
      if (stx.indexOf('nao vendido') > -1 || stx.indexOf('não vendido') > -1) {
        fields = { vendido: B_(false), condicional: B_(false) };
      } else if (stx.indexOf('condicional') > -1) {
        if (aprovado) { fields = { vendido: B_(true), condicional: B_(false), valorVenda: D_(vv) }; vend++; tot += vv; }
        else { fields = { vendido: B_(false), condicional: B_(true), valorVenda: D_(vv) }; conds++; }
      } else if (stx.indexOf('vendido') > -1) {
        fields = { vendido: B_(true), condicional: B_(false), valorVenda: D_(vv) }; vend++; tot += vv;
      }
      if (fields) fsPatch_('lotes/' + ex.id, fields, Object.keys(fields));
    }
    fsPatch_('emails_processados/resultado-' + leilao,
      { tipo: S_('resultado'), leilao: S_(leilao), status: S_(aprovado ? 'finalizado' : 'aguardando-aprovacao'), atualizadoEm: S_(new Date().toISOString()) }, null);
    log.push('Resultado ' + leilao + ': ' + vend + ' vendido(s) = R$ ' + tot.toFixed(2)
      + (conds ? (' | ' + conds + ' condicional(is) AGUARDANDO sua aprovacao - responda o e-mail da Sodre.') : '')
      + (aprovado ? ' (sua aprovacao foi detectada)' : ''));
  }

  // 2) PRESTACAO DE CONTAS -> BAIXA
  var ths2 = GmailApp.search('subject:prestacao OR subject:"prestação" newer_than:14d');
  for (var t2 = 0; t2 < ths2.length; t2++) {
    var th2 = ths2[t2];
    var subj2 = th2.getFirstMessageSubject();
    if (!/presta/i.test(subj2) || !/contas/i.test(subj2)) continue;
    var m2 = subj2.match(/(\d{5})/); if (!m2) continue;
    var leilao2 = m2[1];
    if (fsGet_('emails_processados/baixa-' + leilao2).code === 200) continue;
    var dt = Utilities.formatDate(th2.getLastMessageDate(), 'America/Sao_Paulo', 'yyyy-MM-dd');
    var alvo = null;
    for (var q = 0; q < leiloes.length; q++) if (String(gv_(leiloes[q], 'numero')) === leilao2) alvo = leiloes[q];
    if (!alvo) { log.push('Baixa ' + leilao2 + ': leilao nao existe no app.'); continue; }
    fsPatch_('leiloes/' + alvo.name.split('/').pop(), { pago: B_(true), pagoEm: S_(dt) }, ['pago', 'pagoEm']);
    var n = 0;
    for (var num2 in porNum) {
      if (num2.indexOf(leilao2 + '-') === 0 && porNum[num2].vendido) {
        fsPatch_('lotes/' + porNum[num2].id, { pago: B_(true) }, ['pago']); n++;
      }
    }
    fsPatch_('emails_processados/baixa-' + leilao2,
      { tipo: S_('baixa'), leilao: S_(leilao2), pagoEm: S_(dt), atualizadoEm: S_(new Date().toISOString()) }, null);
    log.push('BAIXA leilao ' + leilao2 + ': pagamento de ' + dt.split('-').reverse().join('/') + ' registrado. ' + n + ' lote(s) marcados como pagos.');
  }

  if (log.length) {
    MailApp.sendEmail(MEU, 'Abadias - Sodre: ' + log.length + ' atualizacao(oes)', log.join('\n'));
  }
}
