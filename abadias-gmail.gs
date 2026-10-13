// ============================================================
// ABADIAS x SODRE - Robo do Gmail (roda nos servidores Google)
// - Resultados: marca vendidos/nao vendidos com valores oficiais;
//   condicionais viram vendidos quando detecta SUA resposta "aprovado".
// - Prestacao de contas (Ricardo): BAIXA automatica (leilao PAGO + lotes pagos)
//   e agora LE O PDF "PC D" (detalhada): lote Cancelado volta para nao vendido,
//   valores de venda viram os REAIS do acerto.
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

// ---------- LOGIN DO ROBO ----------
// O robo entra com a MESMA conta que voce usa no app. A senha NAO fica aqui no
// codigo (nem no GitHub): fica em Configuracoes do projeto > Propriedades do script.
var _tk = null, _tkExp = 0;

function fsToken_() {
  var agora = new Date().getTime();
  if (_tk && agora < _tkExp) return _tk;
  var p = PropertiesService.getScriptProperties();
  var em = p.getProperty('ABADIAS_EMAIL'), se = p.getProperty('ABADIAS_SENHA');
  if (!em || !se) throw new Error('faltam ABADIAS_EMAIL e ABADIAS_SENHA nas Propriedades do script');
  var r = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + FS_KEY, {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ email: em, password: se, returnSecureToken: true }),
    muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('login do robo recusado (HTTP ' + r.getResponseCode() + ')');
  var j = JSON.parse(r.getContentText());
  _tk = j.idToken;
  _tkExp = agora + (Number(j.expiresIn || 3600) - 300) * 1000;  // renova 5 min antes de vencer
  return _tk;
}
function fsHeaders_() { return { Authorization: 'Bearer ' + fsToken_() }; }

function testarLoginRobo() {
  var t = fsToken_();
  var r = fsGet_('lotes/sodre-29029-001');
  var msg = 'Login do robo OK (token de ' + t.length + ' caracteres).\n'
          + 'Leitura de teste no Firestore: HTTP ' + r.code + '.';
  Logger.log(msg);
  return msg;
}

// ---------- Firestore ----------
function fsGet_(path) {
  var r = null;
  for (var tent = 0; tent < 3; tent++) {
    r = UrlFetchApp.fetch(FS_BASE + '/' + path + '?key=' + FS_KEY, { headers: fsHeaders_(), muteHttpExceptions: true });
    var c = r.getResponseCode();
    if (c == 200 || c == 404) break;
    Utilities.sleep(1500);
  }
  return { code: r.getResponseCode(), json: r.getResponseCode() == 200 ? JSON.parse(r.getContentText()) : null };
}
function fsPatch_(path, fields, mask) {
  var url = FS_BASE + '/' + path + '?key=' + FS_KEY;
  if (mask) for (var i = 0; i < mask.length; i++) url += '&updateMask.fieldPaths=' + mask[i];
  var r = UrlFetchApp.fetch(url, { method: 'patch', contentType: 'application/json',
    headers: fsHeaders_(),
    payload: JSON.stringify({ fields: fields }), muteHttpExceptions: true });
  return r.getResponseCode() == 200;
}
function fsList_(col) {
  var out = [], tk = '';
  do {
    var u = FS_BASE + '/' + col + '?key=' + FS_KEY + '&pageSize=100' + (tk ? '&pageToken=' + tk : '');
    var j = JSON.parse(UrlFetchApp.fetch(u, { headers: fsHeaders_() }).getContentText());
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
function pdfParaTexto_(blob) {
  var boundary = 'xxABADIASPDFxx';
  var meta = { name: 'abadias-pdf-tmp', mimeType: 'application/vnd.google-apps.document' };
  var head = Utilities.newBlob('--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'
    + JSON.stringify(meta) + '\r\n--' + boundary + '\r\nContent-Type: application/pdf\r\n\r\n').getBytes();
  var tail = Utilities.newBlob('\r\n--' + boundary + '--').getBytes();
  var payload = head.concat(blob.getBytes()).concat(tail);
  var r = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'post', contentType: 'multipart/related; boundary=' + boundary, payload: payload,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } });
  var id = JSON.parse(r.getContentText()).id;
  var txt = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + id + '/export?mimeType=text/plain', {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } }).getContentText();
  UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + id, {
    method: 'delete', headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  return txt;
}
// Le a Prestacao de Contas Detalhada (PDF "PC D") por BLOCO de lote.
// O texto vem com o status colado na descricao, ex: "...acondicionados eCancelado004 475,20 M2".
// Por isso localizamos o inicio de cada lote (001, 002, ...) e lemos so o pedaco dele.
function parsePrestacao_(txt) {
  txt = String(txt || '').replace(/[\u200B-\u200D\uFEFF]/g, '');
  var mt = txt.match(/Total de Lotes:\s*(\d+)/);
  if (!mt) return null;
  var N = Number(mt[1]);
  if (!N || N > 400) return null;
  var fim = txt.indexOf('Total de Lotes');
  var corpo = txt.slice(0, fim > 0 ? fim : txt.length);
  var pos = [], busca = 0;
  for (var i = 1; i <= N; i++) {
    var alvo = ('000' + i).slice(-3);
    var re = new RegExp('(?:^|[\\r\\n]|[A-Za-z\\u00C0-\\u017F])(' + alvo + ')[\\s\\u00A0]+\\S', 'g');
    re.lastIndex = busca;
    var m = re.exec(corpo);
    if (!m) return null;
    var idx = m.index + m[0].indexOf(alvo);
    pos.push({ num: alvo, ini: idx });
    busca = idx + 3;
  }
  var out = {};
  for (var k = 0; k < pos.length; k++) {
    var ini2 = pos[k].ini;
    var f2 = (k + 1 < pos.length) ? pos[k + 1].ini : corpo.length;
    var bloco = corpo.slice(ini2, f2);
    var ms = bloco.match(/(Cancelado|SemLicitante|Sem Licitante|Retirado|Vendido)/g) || [];
    var st = ms.length ? String(ms[0]).replace(/\s+/g, '') : '';
    if (!st) return null;
    var venda = 0, comprador = '', doc = '';
    if (st === 'Vendido') {
      var mv = bloco.match(/R\$\s*([\d.]+,\d{2})/);
      if (mv) venda = Number(mv[1].replace(/\./g, '').replace(',', '.')) || 0;
      // NOME REAL do arrematante (o site so mostra mascarado)
      var mn = bloco.match(/Vendido\s*Para\s*:?\s*([^\n]+)/i);
      if (mn) {
        comprador = mn[1]
          .replace(/Avalia.{0,8}?o\s*Venda/gi, ' ')
          .replace(/Avalia.{0,8}?o/gi, ' ')
          .replace(/\bVenda\b/gi, ' ')
          .replace(/R\$[\s\S]*$/, '')
          .replace(/\s{2,}/g, ' ').trim();
        if (comprador.length < 3) comprador = '';
      }
      var md = bloco.match(/(?:CPF|CGC|CNPJ)\s*:?\s*([\d][\d.\-\/]{9,19})/i);
      if (md) doc = md[1].trim();
    }
    out[pos[k].num] = { st: st, venda: venda, comprador: comprador, doc: doc };
  }
  return out;
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

  // BACKUP primeiro, antes de qualquer outra coisa: se o resto quebrar, a copia ja esta salva.
  try {
    var _bk = backupDiario_(false);
    // sucesso so avisa na segunda-feira (prova semanal); falha avisa SEMPRE.
    if (_bk && new Date().getDay() === 1) {
      log.push('BACKUP do banco OK: ' + _bk.nome + ' (' + _bk.docs + ' documentos, ' + _bk.kb + ' KB) na pasta "' + BK_PASTA + '" do seu Drive.');
    }
  } catch (eBk) {
    log.push('ATENCAO: o BACKUP de hoje NAO foi gravado - ' + eBk.message
           + '\n  O banco esta sem copia de hoje. Os anteriores continuam na pasta "' + BK_PASTA + '".');
  }
  var lotes = fsList_('lotes');
  var porNum = {};
  for (var i = 0; i < lotes.length; i++) {
    var d = lotes[i];
    var _arr = String(gv_(d, 'arrematante') || '');
    porNum[String(gv_(d, 'num'))] = { id: d.name.split('/').pop(), vendido: gv_(d, 'vendido') === true, pago: gv_(d, 'pago') === true, cancelado: gv_(d, 'cancelado') === true,
      nomeOk: !!_arr && _arr.indexOf('*') === -1 && _arr.length > 3 };
  }
  var leiloes = fsList_('leiloes');

  // 1) RESULTADOS
  var ths = GmailApp.search('from:montagem@sodresantoro.com.br newer_than:14d has:attachment');
  for (var t = 0; t < ths.length; t++) {
    var th = ths[t];
    var subj = String(th.getFirstMessageSubject() || '').replace(/[\u200B-\u200D\uFEFF]/g, '');
    if (!/resultado/i.test(subj)) continue;
    var m = subj.match(/(\d{5})/); if (!m) continue;
    var leilao = m[1];
    var st = fsGet_('emails_processados/resultado-' + leilao);
    if (st.code !== 200 && st.code !== 404) { log.push('Resultado ' + leilao + ': status ilegivel (' + st.code + '), pulei por seguranca.'); continue; }
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
      if (ex.pago || ex.cancelado) continue;
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
    var stB = fsGet_('emails_processados/baixa-' + leilao2);
    if (stB.code !== 200 && stB.code !== 404) { log.push('Baixa ' + leilao2 + ': status ilegivel (' + stB.code + '), pulei por seguranca.'); continue; }
    var jaFeita = (stB.code === 200);
    // rede de seguranca: se a baixa ja rodou mas algum lote vendido segue sem o nome real, tenta de novo
    var faltaNome = false;
    for (var nF in porNum) {
      if (nF.indexOf(leilao2 + '-') === 0 && porNum[nF].vendido && !porNum[nF].nomeOk) { faltaNome = true; break; }
    }
    if (jaFeita && !faltaNome) continue;
    var soNomes = jaFeita;   // ja processada: mexe SO no nome, nao refaz a baixa
    var dt = Utilities.formatDate(th2.getLastMessageDate(), 'America/Sao_Paulo', 'yyyy-MM-dd');
    var alvo = null;
    for (var q = 0; q < leiloes.length; q++) if (String(gv_(leiloes[q], 'numero')) === leilao2) alvo = leiloes[q];
    if (!alvo) { log.push('Baixa ' + leilao2 + ': leilao nao existe no app.'); continue; }
    // Le o PDF "PC D" (Prestacao de Contas Detalhada) para saber cancelados e valores REAIS
    var pcd = null;
    var msgs2 = th2.getMessages();
    for (var k2 = 0; k2 < msgs2.length && !pcd; k2++) {
      var as2 = msgs2[k2].getAttachments();
      for (var j2 = 0; j2 < as2.length; j2++) {
        if (/PC\s*D/i.test(as2[j2].getName()) && /\.pdf$/i.test(as2[j2].getName())) { pcd = as2[j2]; break; }
      }
    }
    var detalhe = null, motivoFalha = '';
    if (!pcd) motivoFalha = 'anexo "PC D" nao encontrado no e-mail';
    if (pcd) {
      try {
        var txtPdf = pdfParaTexto_(pcd.copyBlob());
        detalhe = parsePrestacao_(txtPdf);
        if (!detalhe) motivoFalha = 'layout do PDF nao reconhecido (status x Total de Lotes nao bateu)';
      } catch (ePdf) { detalhe = null; motivoFalha = 'erro ao converter o PDF: ' + String(ePdf).slice(0, 120); }
    }
    // Valor LIQUIDO realmente recebido: vem do nome do comprovante, ex "3.990,00 FRANCISCO.pdf"
    var vRec = 0;
    for (var k3 = 0; k3 < msgs2.length && !vRec; k3++) {
      var as3 = msgs2[k3].getAttachments();
      for (var j3 = 0; j3 < as3.length; j3++) {
        var mv3 = as3[j3].getName().match(/^\s*([\d.]+,\d{2})\s/);
        if (mv3) { vRec = Number(mv3[1].replace(/\./g, '').replace(',', '.')) || 0; break; }
      }
    }
    if (!soNomes) {
      var fL = { pago: B_(true), pagoEm: S_(dt) }, mL = ['pago', 'pagoEm'];
      if (vRec > 0) { fL.valorRecebido = D_(vRec); mL.push('valorRecebido'); }
      fsPatch_('leiloes/' + alvo.name.split('/').pop(), fL, mL);
    }
    var n = 0, canc = 0, nomes = 0, totReal = 0, detLog = [];
    if (detalhe) {
      for (var num3 in detalhe) {
        var numFull = leilao2 + '-' + num3;
        var ex3 = porNum[numFull]; if (!ex3) continue;
        var st3 = detalhe[num3].st;
        if (soNomes) {                      // baixa ja feita: so completa o comprador que faltou
          if (st3 === 'Vendido' && !ex3.nomeOk && detalhe[num3].comprador) {
            var fN = { arrematante: S_(detalhe[num3].comprador) }, mN = ['arrematante'];
            if (detalhe[num3].doc) { fN.arrematanteDoc = S_(detalhe[num3].doc); mN.push('arrematanteDoc'); }
            fsPatch_('lotes/' + ex3.id, fN, mN); nomes++;
            detLog.push(numFull + ': comprador preenchido (' + detalhe[num3].comprador + ')');
          }
          continue;
        }
        if (st3 === 'Cancelado') {
          fsPatch_('lotes/' + ex3.id, { vendido: B_(false), condicional: B_(false), pago: B_(false), cancelado: B_(true) },
            ['vendido', 'condicional', 'pago', 'cancelado', 'valorVenda', 'arrematante']);
          canc++; detLog.push(numFull + ': CANCELADO (volta para nao vendidos)');
        } else if (st3 === 'Vendido') {
          var f3 = { vendido: B_(true), condicional: B_(false), pago: B_(true) };
          var mk3 = ['vendido', 'condicional', 'pago'];
          if (detalhe[num3].venda > 0) { f3.valorVenda = D_(detalhe[num3].venda); mk3.push('valorVenda'); totReal += detalhe[num3].venda; }
          if (detalhe[num3].comprador) { f3.arrematante = S_(detalhe[num3].comprador); mk3.push('arrematante'); nomes++; }
          if (detalhe[num3].doc) { f3.arrematanteDoc = S_(detalhe[num3].doc); mk3.push('arrematanteDoc'); }
          fsPatch_('lotes/' + ex3.id, f3, mk3); n++;
        } else { // SemLicitante / Retirado: garante nao vendido e nao pago
          fsPatch_('lotes/' + ex3.id, { vendido: B_(false), condicional: B_(false), pago: B_(false) },
            ['vendido', 'condicional', 'pago']);
        }
      }
    } else {
      // Sem o detalhe NAO marcamos lote nenhum: ja deu erro grave assim antes.
      detLog.push('ATENCAO: os lotes NAO foram marcados como pagos porque ' + motivoFalha + '.');
      detLog.push('Confira a prestacao de contas no Gmail e ajuste no app.');
    }
    /* Registra SE a baixa foi aplicada. Antes gravava o mesmo marcador tendo
       dado certo ou nao, e o app nao conseguia distinguir "a Sodre atrasou" de
       "o robo nao conseguiu ler a prestacao" - duas coisas que pedem acoes
       opostas (cobrar x abrir o e-mail). */
    fsPatch_('emails_processados/baixa-' + leilao2,
      { tipo: S_('baixa'), leilao: S_(leilao2), pagoEm: S_(dt), atualizadoEm: S_(new Date().toISOString()),
        baixaAplicada: B_(!!detalhe), motivoFalha: S_(detalhe ? '' : (motivoFalha || 'motivo nao registrado')) }, null);
    if (soNomes) {
      if (nomes) log.push('Leilao ' + leilao2 + ': ' + nomes + ' comprador(es) preenchido(s) na 2a tentativa.\n  ' + detLog.join('\n  '));
      continue;
    }
    log.push('BAIXA leilao ' + leilao2 + ': pagamento de ' + dt.split('-').reverse().join('/') + ' registrado. '
      + n + ' lote(s) pagos' + (canc ? ', ' + canc + ' CANCELADO(S)' : '') + (nomes ? ', ' + nomes + ' comprador(es) identificado(s)' : '')
      + (vRec ? ' | RECEBIDO (liquido) R$ ' + vRec.toFixed(2) : '')
      + (totReal ? ' | vendas reais R$ ' + totReal.toFixed(2) : '')
      + (detLog.length ? '\n  ' + detLog.join('\n  ') : ''));
  }

  // Fechamento do Pos-Venda: le por ultimo, para cancelar o que nao vai ser pago.
  try { lerFechamentos_(log); }
  catch (eF) { log.push('ATENCAO: nao consegui ler os e-mails de FECHAMENTO - ' + eF.message); }

  if (log.length) {
    MailApp.sendEmail(MEU, 'Abadias - Sodre: ' + log.length + ' atualizacao(oes)', log.join('\n'));
  }
}

// ============================================================
// BACKUP DIARIO DO BANCO  (roda junto com o main_, 1x por dia)
// Grava um JSON com TODAS as colecoes numa pasta do seu Drive.
// Regra de ouro: nunca sobrescreve um backup bom por um ruim.
// ============================================================
var BK_PASTA = 'Abadias - Backups';
var BK_COLS  = ['lotes','leiloes','fotos_lotes','termos_retirada','termos_chunks',
                'emails_processados','lotes_ignorados','lotes_backup'];
var BK_DIAS  = 60;   // guarda 60 dias
var BK_MIN   = 50;   // se vier menos que isso de doc, e leitura falha: aborta

function pastaBackup_() {
  var it = DriveApp.getFoldersByName(BK_PASTA);
  return it.hasNext() ? it.next() : DriveApp.createFolder(BK_PASTA);
}

// Le as colecoes e monta o pacote. Se QUALQUER colecao falhar, estoura -
// melhor ficar sem o backup de hoje do que gravar um pela metade.
function dumpCols_(cols) {
  var dump = { gerado: new Date().toISOString(), versao: 1, colecoes: {}, totalDocs: 0 };
  for (var i = 0; i < cols.length; i++) {
    var col = cols[i], docs = null, erro = '';
    for (var tent = 0; tent < 3 && docs === null; tent++) {
      try { docs = fsList_(col); } catch (e) { erro = String(e); Utilities.sleep(2000); }
    }
    if (docs === null) throw new Error('colecao "' + col + '" ilegivel (' + erro + ')');
    var arr = [];
    for (var j = 0; j < docs.length; j++) {
      arr.push({ id: docs[j].name.split('/').pop(), fields: docs[j].fields || {} });
    }
    dump.colecoes[col] = arr;
    dump.totalDocs += arr.length;
  }
  return dump;
}

function backupDiario_(forcar) {
  var hoje  = Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'yyyy-MM-dd');
  var nome  = 'abadias-' + hoje + '.json';
  var pasta = pastaBackup_();
  if (!forcar && pasta.getFilesByName(nome).hasNext()) return null;  // ja tem o de hoje

  var dump = dumpCols_(BK_COLS);
  if (dump.totalDocs < BK_MIN) {
    throw new Error('backup abortado: so ' + dump.totalDocs + ' documentos lidos (minimo ' + BK_MIN + ').');
  }
  var ex = pasta.getFilesByName(nome);
  while (ex.hasNext()) ex.next().setTrashed(true);
  var f = pasta.createFile(nome, JSON.stringify(dump), 'application/json');
  limparBackupsAntigos_(pasta);
  return { nome: nome, docs: dump.totalDocs, kb: Math.round(f.getSize() / 1024) };
}

function limparBackupsAntigos_(pasta) {
  var lim = new Date().getTime() - BK_DIAS * 86400000;
  var fs = pasta.getFiles(), todos = [];
  while (fs.hasNext()) todos.push(fs.next());
  if (todos.length <= 7) return;                       // sempre guarda pelo menos 7
  for (var i = 0; i < todos.length; i++) {
    if (todos[i].getDateCreated().getTime() < lim) todos[i].setTrashed(true);
  }
}

// ---------- RESTAURACAO ----------
// Grava de volta os documentos do pacote. Nao apaga nada que exista hoje
// e nao esteja no backup - so repoe/sobrescreve o que estava la.
function restaurarDump_(dump, cols, dryRun) {
  var res = { gravados: 0, falhas: 0, porCol: {} };
  for (var i = 0; i < cols.length; i++) {
    var col = cols[i], arr = (dump.colecoes || {})[col];
    if (!arr) continue;
    var ok = 0, bad = 0;
    for (var j = 0; j < arr.length; j++) {
      var d = arr[j], mask = [];
      for (var k in d.fields) mask.push(k);
      if (dryRun) { ok++; continue; }
      if (fsPatch_(col + '/' + d.id, d.fields, mask)) ok++; else bad++;
    }
    res.porCol[col] = ok + (bad ? ' (' + bad + ' falha)' : '');
    res.gravados += ok; res.falhas += bad;
  }
  return res;
}

// USO MANUAL: abra a pasta "Abadias - Backups" no Drive, pegue o nome do arquivo,
// coloque abaixo e rode esta funcao. Deixe dryRun=true primeiro para so conferir.
function restaurarBackup() {
  var ARQUIVO = 'abadias-2026-09-24.json';   // <<< troque pela data que voce quer
  var COLECOES = BK_COLS;                    // ou ex: ['lotes']
  var DRY_RUN = true;                        // <<< true = so simula. false = grava de verdade

  var it = pastaBackup_().getFilesByName(ARQUIVO);
  if (!it.hasNext()) throw new Error('nao achei o arquivo ' + ARQUIVO);
  var dump = JSON.parse(it.next().getBlob().getDataAsString());
  var r = restaurarDump_(dump, COLECOES, DRY_RUN);
  var msg = (DRY_RUN ? '[SIMULACAO] ' : '[GRAVADO] ') + ARQUIVO
          + '\nBackup de: ' + dump.gerado + '\nDocumentos: ' + JSON.stringify(r.porCol)
          + '\nTotal: ' + r.gravados + (r.falhas ? ' | FALHAS: ' + r.falhas : '');
  Logger.log(msg);
  MailApp.sendEmail(Session.getActiveUser().getEmail(), 'Abadias - restauracao de backup', msg);
  return msg;
}

// ---------- TESTE REAL DO CICLO (usa colecao descartavel) ----------
function testarBackupRestore() {
  var COL = 'backup_teste', ID = 'roundtrip';
  var marca = 'teste-' + new Date().getTime();
  var passos = [];

  fsPatch_(COL + '/' + ID, { marca: S_(marca), numero: D_(1234.56), flag: B_(true) },
           ['marca','numero','flag']);
  passos.push('1. gravou doc de teste com marca=' + marca);

  var dump = dumpCols_([COL]);
  var achou = (dump.colecoes[COL] || []).filter(function (d) { return d.id === ID; })[0];
  if (!achou) throw new Error('FALHOU: o backup nao capturou o documento de teste');
  passos.push('2. backup capturou o doc (' + dump.totalDocs + ' doc na colecao)');

  fsPatch_(COL + '/' + ID, { marca: S_('DESTRUIDO'), numero: D_(0), flag: B_(false) },
           ['marca','numero','flag']);
  var conf = fsGet_(COL + '/' + ID);
  if (gv_(conf.json, 'marca') !== 'DESTRUIDO') throw new Error('FALHOU: nao consegui destruir o doc para testar');
  passos.push('3. destruiu o doc de proposito (marca=DESTRUIDO)');

  var r = restaurarDump_(dump, [COL], false);
  var pos = fsGet_(COL + '/' + ID);
  var m = gv_(pos.json, 'marca'), n = gv_(pos.json, 'numero'), b = gv_(pos.json, 'flag');
  if (m !== marca || Number(n) !== 1234.56 || b !== true) {
    throw new Error('FALHOU: restauracao nao bateu. marca=' + m + ' numero=' + n + ' flag=' + b);
  }
  passos.push('4. restaurou e conferiu: marca/numero/flag identicos ao original');

  UrlFetchApp.fetch(FS_BASE + '/' + COL + '/' + ID + '?key=' + FS_KEY,
                    { method: 'delete', headers: fsHeaders_(), muteHttpExceptions: true });
  passos.push('5. limpou a colecao de teste');

  var msg = 'CICLO BACKUP -> RESTAURACAO: OK\n\n' + passos.join('\n');
  Logger.log(msg);
  return msg;
}

function backupAgora() {
  var r = backupDiario_(true);
  var msg = 'Backup gravado: ' + r.nome + ' | ' + r.docs + ' documentos | ' + r.kb + ' KB'
          + '\nPasta no Drive: ' + BK_PASTA;
  Logger.log(msg);
  return msg;
}

// ============================================================
// FECHAMENTO DE LEILAO (planilha da Lainara / Pos-Venda)
// Chega dias depois do pregao, de remetente e formato DIFERENTES da
// prestacao do Ricardo. O robo nao vigiava isso: o fechamento do 29068
// chegou em 01/10 dizendo que os 2 lotes foram CANCELADOS e o app ficou
// 11 dias mostrando "R$ 11.875 ATRASADO" de dinheiro que nao existe.
//
// Regra desta funcao: so age no caso inequivoco (linha com o numero do
// lote + a palavra "cancelado"). Qualquer outra coisa ela NAO adivinha -
// manda e-mail pedindo conferencia. Formato de terceiro muda sem aviso;
// chutar aqui mexe no seu financeiro.
// ============================================================
function lerFechamentos_(log) {
  var ths = GmailApp.search('subject:FECHAMENTO has:attachment newer_than:60d');
  for (var t = 0; t < ths.length; t++) {
    var msgs = ths[t].getMessages();
    for (var m = 0; m < msgs.length; m++) {
      var msg = msgs[m], assunto = msg.getSubject() || '';
      var mn = assunto.match(/\b(\d{5})\b/);
      if (!mn) continue;
      var leilao = mn[1];

      var marca = 'fechamento-' + leilao;
      if (fsGet_('emails_processados/' + marca).code === 200) continue;   // ja tratado

      var anexos = msg.getAttachments(), planilha = null;
      for (var a = 0; a < anexos.length; a++) {
        if (/\.xlsx?$/i.test(anexos[a].getName())) { planilha = anexos[a]; break; }
      }
      if (!planilha) continue;

      var linhas = null;
      try { linhas = xlsParaLinhas_(planilha.copyBlob()); } catch (e) { linhas = null; }
      if (!linhas) {
        log.push('ATENCAO: chegou o FECHAMENTO do leilao ' + leilao + ' e eu nao consegui abrir a planilha.'
               + '\n  Abra o e-mail e confira na mao se algum lote foi cancelado.');
        continue;
      }

      // Procura, linha a linha, o numero do lote e um status inequivoco.
      var cancelados = [], duvidosos = [];
      for (var i = 0; i < linhas.length; i++) {
        var txt = linhas[i].join(' | ');
        var ml = txt.match(new RegExp('\\b' + leilao + '\\s*[-/.]?\\s*(\\d{1,4})\\b'));
        if (!ml) {
          var so = txt.match(/^\s*\|?\s*(\d{1,3})\s*\|/);
          if (!so) continue;
          ml = [null, so[1]];
        }
        var num = leilao + '-' + ('00' + ml[1]).slice(-3);
        if (/cancelad/i.test(txt)) cancelados.push(num);
        else if (/sem\s*licitante|retirad|n[aã]o\s*pag/i.test(txt)) duvidosos.push(num + ' (' + txt.slice(0, 60) + ')');
      }

      var feitos = 0, naoAchei = [];
      for (var c = 0; c < cancelados.length; c++) {
        var alvo = porNumGlobal_(cancelados[c]);
        if (!alvo) { naoAchei.push(cancelados[c]); continue; }
        if (alvo.cancelado === true) continue;
        if (fsPatch_('lotes/' + alvo.id, {
              cancelado: B_(true), vendido: B_(false), valorVenda: D_(0), pago: B_(false),
              obs: S_('Cancelado no fechamento do leilao ' + leilao + ' (planilha do Pos-Venda da Sodre).')
            }, ['cancelado', 'vendido', 'valorVenda', 'pago', 'obs'])) feitos++;
      }

      fsPatch_('emails_processados/' + marca,
        { tipo: S_('fechamento'), leilao: S_(leilao), lido: S_(new Date().toISOString()),
          cancelados: S_(cancelados.join(',')) }, null);

      var aviso = 'FECHAMENTO do leilao ' + leilao + ' lido (planilha do Pos-Venda).';
      if (feitos) aviso += '\n  ' + feitos + ' lote(s) marcados como CANCELADO: ' + cancelados.join(', ')
                        + '\n  Esses lotes sairam do financeiro - o dinheiro deles nao vai cair.';
      if (!cancelados.length) aviso += '\n  Nenhum lote cancelado encontrado na planilha.';
      if (naoAchei.length) aviso += '\n  ATENCAO: nao achei no Abadias: ' + naoAchei.join(', ');
      if (duvidosos.length) aviso += '\n  CONFIRA NA MAO (nao mexi): ' + duvidosos.join(' ; ');
      log.push(aviso);
    }
  }
}

// Busca um lote pelo numero, direto no banco (o robo nao mantem indice global).
function porNumGlobal_(num) {
  var ls = fsList_('lotes');
  for (var i = 0; i < ls.length; i++) {
    if (String(gv_(ls[i], 'num')) === String(num)) {
      return { id: ls[i].name.split('/').pop(), cancelado: gv_(ls[i], 'cancelado') === true };
    }
  }
  return null;
}
