// Robo Sodre -> Abadias v2
// 1) CADASTRA automaticamente lotes novos publicados na pagina exclusiva do vendedor
//    (cria tambem o leilao correspondente se nao existir).
// 2) ATUALIZA lanceAtual e arrematante dos lotes existentes.
// Nunca apaga nada; nunca altera lotes vendidos/pagos; nunca duplica (checa o num).
import { chromium } from 'playwright';

var PROJECT = 'porcelarte-leiloes';
var KEY = 'AIzaSyCk5wE8UUvUGOTjEGzEGecCBFjRd4Am0ro';
var B = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents';
var PAGINA = 'https://www.sodresantoro.com.br/materiais/lotes?client_name=' +
  encodeURIComponent('francisco alves de oliveira porcelanato (porcelart') + '&sort=auction_date_init_asc';
var MAX_CRIACOES = 60;

function parseBRL(t) { return Number(String(t).replace(/\./g, '').replace(',', '.')) || 0; }
function S(v) { return { stringValue: String(v) }; }
function D(v) { return { doubleValue: Number(v) || 0 }; }
function BO(v) { return { booleanValue: !!v }; }

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

async function main() {
  var browser = await chromium.launch();
  var ctx = await browser.newContext({
    bypassCSP: true,
    locale: 'pt-BR',
    viewport: { width: 1366, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  });
  var page = await ctx.newPage();
  await page.goto(PAGINA, { waitUntil: 'domcontentloaded', timeout: 90000 });
  try {
    await page.waitForFunction(function () {
      return /Leilão\s+\d+\s*-\s*\d+/.test(document.body.innerText) && /Lance (inicial|atual)/.test(document.body.innerText);
    }, { timeout: 150000 });
  } catch (e) {
    console.log('AVISO: pagina do vendedor nao carregou lotes. Nada alterado. Detalhe: ' + (e && e.message ? e.message.slice(0, 200) : e));
    await browser.close(); return;
  }
  await page.waitForTimeout(5000);
  var text = await page.evaluate(function () { return document.body.innerText; });
  await browser.close();

  var re = /Leilão\s+(\d{4,6})\s*-\s*(\d{1,4})\s*\n(?:(\d+)\n)?([^\n]+)\n[^\n]*\n(\d{2}\/\d{2}\/\d{2})\s+(\d{2}:\d{2})[\s\S]*?Lance (atual|inicial)\s*\(R\$\)(?:\s*-\s*([^\n]+))?\s*\n+\s*([\d.]+,\d{2})/g;
  var achados = [], m;
  while ((m = re.exec(text))) {
    var dt = m[5].split('/');
    achados.push({
      num: m[1] + '-' + String(m[2]).padStart(3, '0'),
      leilao: m[1],
      titulo: m[4].trim(),
      data: '20' + dt[2] + '-' + dt[1] + '-' + dt[0],
      hora: m[6],
      tipo: m[7],
      arrem: (m[8] || '').trim(),
      valor: parseBRL(m[9])
    });
  }
  console.log('Pagina do vendedor: ' + achados.length + ' lote(s).');
  if (!achados.length) { console.log('AVISO: parser nao encontrou lotes. Nada alterado.'); return; }

  var lotes = await listar('lotes', ['num', 'lanceAtual', 'arrematante', 'vendido', 'pago']);
  var porNum = {}; for (var l of lotes) porNum[String(l.num)] = l;
  var leiloes = await listar('leiloes', ['numero']);
  var numerosLeilao = {}; for (var le of leiloes) numerosLeilao[String(le.numero)] = true;

  var criadosLotes = 0, criadosLeiloes = 0, upd = 0, iguais = 0, skip = 0;

  for (var a of achados) {
    var ex = porNum[a.num];

    if (!ex) {
      if (criadosLotes >= MAX_CRIACOES) { console.log('LIMITE de criacoes atingido; ' + a.num + ' fica para a proxima.'); continue; }
      if (!numerosLeilao[a.leilao]) {
        var rl = await fetch(B + '/leiloes?key=' + KEY, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: { numero: S(a.leilao), data: S(a.data), custoEdital: D(0), criadoEm: S(new Date().toISOString()) } })
        });
        if (rl.ok) { numerosLeilao[a.leilao] = true; criadosLeiloes++; console.log('Leilao criado: ' + a.leilao + ' (' + a.data + ')'); }
      }
      var m2m = a.titulo.match(/([\d.,]+)\s*M²/i);
      var campos = {
        num: S(a.num), descricao: S(a.titulo), categoria: S('Outros'),
        data: S(a.data), hora: S(a.hora), leilaoNum: S(a.leilao),
        lanceInicial: D(a.valor), lanceAtual: D(a.valor),
        incremento: D(0), arrematante: S(a.arrem),
        vendido: BO(false), condicional: BO(false), retirou: BO(false), pago: BO(false),
        obs: S('Produto sem garantia, sem troca e sem devolucao, comprado no estado que se encontra.'),
        localizacao: S('Hortolandia - SP'),
        criadoEm: S(new Date().toISOString()), origem: S('robo-sodre')
      };
      if (m2m) campos.m2 = D(parseBRL(m2m[1]));
      var rc = await fetch(B + '/lotes?key=' + KEY, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: campos })
      });
      if (rc.ok) { criadosLotes++; console.log('LOTE CRIADO: ' + a.num + ' | ' + a.titulo.slice(0, 50) + ' | ' + a.data + ' ' + a.hora + ' | R$ ' + a.valor); }
      else { console.log('ERRO ao criar ' + a.num + ': ' + rc.status); }
      continue;
    }

    if (ex.vendido || ex.pago) { skip++; continue; }
    if (a.tipo !== 'atual') { continue; }
    var exLance = Number(ex.lanceAtual) || 0, exArr = ex.arrematante || '';
    if (Math.abs(exLance - a.valor) < 0.005 && exArr === a.arrem) { iguais++; continue; }
    var r2 = await fetch(B + '/lotes/' + ex._id + '?key=' + KEY + '&updateMask.fieldPaths=lanceAtual&updateMask.fieldPaths=arrematante', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { lanceAtual: D(a.valor), arrematante: S(a.arrem) } })
    });
    if (r2.ok) { upd++; console.log('Lance atualizado ' + a.num + ': R$ ' + a.valor + (a.arrem ? ' (' + a.arrem + ')' : '')); }
    else { console.log('ERRO ao atualizar ' + a.num + ': ' + r2.status); }
  }

  console.log('Fim: ' + criadosLotes + ' lote(s) criado(s), ' + criadosLeiloes + ' leilao(oes) criado(s), ' + upd + ' lance(s) atualizado(s), ' + iguais + ' sem mudanca, ' + skip + ' vendidos ignorados.');
}

main().catch(function (e) { console.error('Erro geral:', e && e.message); process.exit(0); });
