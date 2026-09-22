// Robo Sodre -> Abadias v5
// 1) CADASTRA lotes novos da pagina exclusiva do vendedor (com link da pagina do lote).
// 2) ATUALIZA lanceAtual/arrematante dos existentes.
// 3) REPOSTAGEM por (REF num): abre a pagina de detalhe dos lotes futuros ainda nao checados
//    e procura "(REF 29030-002)" na descricao (marca inserida pela exportacao do Abadias).
//    Achou -> antigo ganha repostado:true + repostadoComo; novo ganha repostDe + refChecado.
//    Nao achou -> refChecado:true (nao revisita). Sem casamento por descricao (dava falso positivo).
import { chromium } from 'playwright';

var PROJECT = 'porcelarte-leiloes';
var KEY = 'AIzaSyCk5wE8UUvUGOTjEGzEGecCBFjRd4Am0ro';
var B = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents';
var PAGINA = 'https://www.sodresantoro.com.br/materiais/lotes?client_name=' +
  encodeURIComponent('francisco alves de oliveira porcelanato (porcelart') + '&sort=auction_date_init_asc';
var MAX_CRIACOES = 60;
var OBS_PADRAO = 'Produto Classe C, sujeito a varia\u00e7\u00f5es de tonalidade, calibre, acabamento, imperfei\u00e7\u00f5es e pontas quebradas. Venda no estado, sem garantia. O lote \u00e9 vendido no estado em que se encontra.';

function parseBRL(t) { return Number(String(t).replace(/\./g, '').replace(',', '.')) || 0; }
function S(v) { return { stringValue: String(v) }; }
function D(v) { return { doubleValue: Number(v) || 0 }; }
function BO(v) { return { booleanValue: !!v }; }
function norm(t) { return String(t || '').toUpperCase().replace(/\s+/g, ' ').trim(); }

async function listar(col, campos) {
  var tk = '', out = [];
  do {
    var url = B + '/' + col + '?key=' + KEY + '&pageSize=100' + (tk ? '&pageToken=' + tk : '');
    for (var c of campos) url += '&mask.fieldPaths=' + c;
    var r = await fetch(url);
    var j = await r.json();
    for (var d of (j.documents || [])) {
      var f = d.fields || {};
      var o = { _id: d.name.split('/').pop() };
      for (var c2 of campos) {
        var x = f[c2]; if (!x) continue;
        if (x.stringValue !== undefined) o[c2] = x.stringValue;
        else if (x.doubleValue !== undefined) o[c2] = x.doubleValue;
        else if (x.integerValue !== undefined) o[c2] = Number(x.integerValue);
        else if (x.booleanValue !== undefined) o[c2] = x.booleanValue;
      }
      out.push(o);
    }
    tk = j.nextPageToken || '';
  } while (tk);
  return out;
}
async function patchLote(id, fields) {
  var url = B + '/lotes/' + id + '?key=' + KEY;
  for (var k in fields) url += '&updateMask.fieldPaths=' + k;
  var r = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: fields }) });
  return r.ok;
}

async function main() {
  var browser = await chromium.launch();
  var ctx = await browser.newContext({
    bypassCSP: true, locale: 'pt-BR', viewport: { width: 1366, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  });
  var page = await ctx.newPage();
  await page.goto(PAGINA, { waitUntil: 'domcontentloaded', timeout: 90000 });
  try {
    await page.waitForFunction(function () {
      return /Leilão\s+\d+\s*-\s*\d+/.test(document.body.innerText) && /Lance (inicial|atual)/.test(document.body.innerText);
    }, { timeout: 150000 });
  } catch (e) {
    console.log('AVISO: pagina do vendedor nao carregou lotes. Nada alterado. Detalhe: ' + (e && e.message ? e.message.slice(0, 150) : e));
    await browser.close(); return;
  }
  await page.waitForTimeout(5000);
  var text = await page.evaluate(function () { return document.body.innerText; });
  var links = await page.evaluate(function () {
    var out = {};
    document.querySelectorAll('a[href]').forEach(function (a) {
      var t = a.innerText || '';
      var m = t.match(/Leilão\s+(\d{4,6})\s*-\s*(\d{1,4})/);
      if (m) out[m[1] + '-' + ('000' + m[2]).slice(-3)] = a.href;
    });
    return out;
  });
  await browser.close();

  var re = /Leilão\s+(\d{4,6})\s*-\s*(\d{1,4})\s*\n(?:(\d+)\n)?([^\n]+)\n[^\n]*\n(\d{2}\/\d{2}\/\d{2})\s+(\d{2}:\d{2})[\s\S]*?Lance (atual|inicial)\s*\(R\$\)(?:\s*-\s*([^\n]+))?\s*\n+\s*([\d.]+,\d{2})/g;
  var achados = [], m;
  while ((m = re.exec(text))) {
    var dt = m[5].split('/');
    var num = m[1] + '-' + String(m[2]).padStart(3, '0');
    achados.push({ num: num, leilao: m[1], titulo: m[4].trim(), data: '20' + dt[2] + '-' + dt[1] + '-' + dt[0], hora: m[6], tipo: m[7], arrem: (m[8] || '').trim(), valor: parseBRL(m[9]), link: links[num] || '' });
  }
  console.log('Pagina do vendedor: ' + achados.length + ' lote(s).');
  if (!achados.length) { console.log('AVISO: parser nao encontrou lotes.'); return; }

  var CAMPOS = ['num', 'descricao', 'data', 'lanceAtual', 'lanceInicial', 'arrematante', 'vendido', 'pago', 'condicional', 'repostado', 'repostDe', 'repostadoComo', 'linkSodre', 'm2', 'refChecado', 'qtdCaixas', 'encerradoChecado'];
  var lotes = await listar('lotes', CAMPOS);
  // Lotes que o Isaque marcou como "nao sao meus" (outro comitente): nunca recriar.
  var IGN = {};
  try { (await listar('lotes_ignorados', ['num'])).forEach(function (x) { IGN[String(x.num)] = true; }); } catch (eI) { }
  if (Object.keys(IGN).length) console.log('Ignorados (nao recriar): ' + Object.keys(IGN).join(', '));
  var porNum = {}; for (var l of lotes) porNum[String(l.num)] = l;
  var leiloes = await listar('leiloes', ['numero']);
  var numerosLeilao = {}; for (var le of leiloes) numerosLeilao[String(le.numero)] = true;

  var criados = 0, criadosLei = 0, upd = 0, iguais = 0, skip = 0, casados = 0;

  for (var a of achados) {
    var ex = porNum[a.num];
    if (!ex) {
      if (criados >= MAX_CRIACOES) continue;
      if (!numerosLeilao[a.leilao]) {
        var rl = await fetch(B + '/leiloes?key=' + KEY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { numero: S(a.leilao), data: S(a.data), custoEdital: D(0), criadoEm: S(new Date().toISOString()) } }) });
        if (rl.ok) { numerosLeilao[a.leilao] = true; criadosLei++; console.log('Leilao criado: ' + a.leilao); }
      }
      if (IGN[a.num]) { console.log('PULADO (nao e meu): ' + a.num); continue; }
      var m2m = a.titulo.match(/([\d.,]+)\s*M²/i);
      var campos = {
        num: S(a.num), descricao: S(a.titulo), categoria: S('Outros'),
        data: S(a.data), hora: S(a.hora), leilaoNum: S(a.leilao),
        lanceInicial: D(a.valor), lanceAtual: D(a.valor), incremento: D(0), arrematante: S(a.arrem),
        vendido: BO(false), condicional: BO(false), retirou: BO(false), pago: BO(false),
        obs: S(OBS_PADRAO),
        localizacao: S('Hortolandia - SP'), criadoEm: S(new Date().toISOString()), origem: S('robo-sodre')
      };
      if (m2m) campos.m2 = D(parseBRL(m2m[1]));
      if (a.link) campos.linkSodre = S(a.link);
      var rc = await fetch(B + '/lotes?key=' + KEY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: campos }) });
      if (rc.ok) {
        criados++; console.log('LOTE CRIADO: ' + a.num + ' | ' + a.titulo.slice(0, 45));
        var jc = await rc.json();
        porNum[a.num] = { _id: jc.name.split('/').pop(), num: a.num, descricao: a.titulo, data: a.data };
      }
      continue;
    }
    if (ex.linkSodre === undefined && a.link) { await patchLote(ex._id, { linkSodre: S(a.link) }); }
    if (ex.vendido || ex.pago) { skip++; continue; }
    if (a.tipo !== 'atual') continue;
    var exL = Number(ex.lanceAtual) || 0, exA = ex.arrematante || '';
    if (Math.abs(exL - a.valor) < 0.005 && exA === a.arrem) { iguais++; continue; }
    if (await patchLote(ex._id, { lanceAtual: D(a.valor), arrematante: S(a.arrem) })) { upd++; console.log('Lance ' + a.num + ': R$ ' + a.valor + (a.arrem ? ' (' + a.arrem + ')' : '')); }
  }

  // 3) CASAMENTO DE REPOSTAGEM POR (REF num) na pagina de detalhe
  var hojeS = new Date().toISOString().slice(0, 10);
  lotes = await listar('lotes', CAMPOS);
  var porNumAll = {};
  lotes.forEach(function (l) { porNumAll[l.num] = l; });
  var candidatos = lotes.filter(function (l) { return l.data && l.data >= hojeS && !l.repostDe && !l.refChecado && l.linkSodre; }).slice(0, 12);
  if (candidatos.length) {
    var b2 = await chromium.launch();
    var ctx2 = await b2.newContext({
      bypassCSP: true, locale: 'pt-BR', viewport: { width: 1366, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    });
    var pg = await ctx2.newPage();
    for (var c of candidatos) {
      try {
        await pg.goto(c.linkSodre, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await pg.waitForTimeout(4000);
        var txt = await pg.evaluate(function () { return document.body.innerText; });
        var pm = txt.match(/\((\d+)\s*Pallets?\)/i) || txt.match(/(\d+)\s*paletes?\b/i);
        if (pm && !c.qtdCaixas) { await patchLote(c._id, { qtdCaixas: S(pm[1] + (pm[1] === '1' ? ' palete' : ' paletes')) }); }
        var mm = txt.match(/\(\s*REF\s*[:.]?\s*(\d{4,6}\s*-\s*\d{1,4})\s*\)/i);
        if (mm) {
          var pr = mm[1].replace(/\s+/g, '').split('-');
          var refNum = pr[0] + '-' + ('000' + pr[1]).slice(-3);
          var antigo = porNumAll[refNum];
          if (antigo && !antigo.repostado && antigo.num !== c.num) {
            var ok1 = await patchLote(antigo._id, { repostado: BO(true), repostadoComo: S(c.num) });
            var ok2 = await patchLote(c._id, { repostDe: S(antigo.num), refChecado: BO(true) });
            if (ok1 && ok2) { casados++; console.log('REPOSTAGEM (REF): ' + antigo.num + ' -> ' + c.num + ' (' + String(c.descricao).slice(0, 40) + ')'); }
            continue;
          }
          console.log('AVISO: REF ' + refNum + ' no lote ' + c.num + ' sem antigo correspondente' + (antigo && antigo.repostado ? ' (ja repostado)' : ''));
        }
        await patchLote(c._id, { refChecado: BO(true) });
      } catch (e) { console.log('Detalhe falhou ' + c.num + ': ' + String(e && e.message || e).slice(0, 90)); }
    }
    await b2.close();
  }

  // 4) LANCES FINAIS de lotes recem-encerrados (cobre janelas puladas pelo cron do GitHub)
  //    Depois do pregao o lote sai da pagina do vendedor; o lance final fica na pagina de detalhe.
  var d2 = new Date(); d2.setDate(d2.getDate() - 2);
  var lim2 = d2.toISOString().slice(0, 10);
  var encerrados = lotes.filter(function (l) {
    return l.data && l.data >= lim2 && l.data <= hojeS && !l.vendido && !l.pago && !l.encerradoChecado && l.linkSodre;
  }).slice(0, 10);
  if (encerrados.length) {
    var b3 = await chromium.launch();
    var ctx3 = await b3.newContext({
      bypassCSP: true, locale: 'pt-BR', viewport: { width: 1366, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    });
    var pg3 = await ctx3.newPage();
    for (var e3 of encerrados) {
      try {
        await pg3.goto(e3.linkSodre, { waitUntil: 'domcontentloaded', timeout: 60000 });
        try { await pg3.waitForFunction(function () { return /Lance/.test(document.body.innerText) && /Leil\u00e3o\s+\d+/.test(document.body.innerText); }, { timeout: 45000 }); } catch (eW3) { }
        await pg3.waitForTimeout(3000);
        var t3 = await pg3.evaluate(function () { return document.body.innerText; });
        var ml = t3.match(/Lance\s*\n*\s*R\$\s*([\d.]+(?:,\d{2})?)/);
        var flds = { encerradoChecado: BO(true) };
        var info = [];
        if (ml) { var lv = parseBRL(ml[1].indexOf(',') > -1 ? ml[1] : ml[1] + ',00'); if (lv > 0) { flds.lanceAtual = D(lv); info.push('lance final R$ ' + lv); } }
        if (/CONDICIONAL/.test(t3)) { flds.condicional = BO(true); info.push('CONDICIONAL'); }
        await patchLote(e3._id, flds);
        console.log('ENCERRADO ' + e3.num + ': ' + (info.length ? info.join(', ') : 'sem dados na pagina'));
      } catch (e4) { console.log('Encerrado falhou ' + e3.num + ': ' + String(e4 && e4.message || e4).slice(0, 80)); }
    }
    await b3.close();
  }

  console.log('Fim: ' + criados + ' criado(s), ' + criadosLei + ' leilao(oes), ' + upd + ' lance(s), ' + casados + ' repostagem(ns) casada(s), ' + iguais + ' sem mudanca, ' + skip + ' vendidos.');
}

main().catch(function (e) { console.error('Erro geral:', e && e.message); process.exit(0); });
