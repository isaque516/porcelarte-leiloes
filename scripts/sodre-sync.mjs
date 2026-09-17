// Robo Sodre -> Abadias: sincroniza lances ao vivo do site publico da Sodre Santoro
// Atualiza SOMENTE lanceAtual e arrematante de lotes que ja existem no app.
// Nunca cria, nunca apaga, ignora lotes ja vendidos/pagos.
import { chromium } from 'playwright';

var PROJECT = 'porcelarte-leiloes';
var KEY = 'AIzaSyCk5wE8UUvUGOTjEGzEGecCBFjRd4Am0ro';
var B = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents';

function parseBRL(t) { return Number(String(t).replace(/\./g, '').replace(',', '.')) || 0; }

async function fetchLotes() {
  var tk = '', out = {};
  do {
    var r = await fetch(B + '/lotes?key=' + KEY + '&pageSize=100' + (tk ? '&pageToken=' + tk : ''));
    var j = await r.json();
    for (var d of (j.documents || [])) {
      var f = d.fields || {};
      function gv(k) {
        var x = f[k]; if (!x) return undefined;
        if (x.stringValue !== undefined) return x.stringValue;
        if (x.doubleValue !== undefined) return x.doubleValue;
        if (x.integerValue !== undefined) return Number(x.integerValue);
        if (x.booleanValue !== undefined) return x.booleanValue;
      }
      var num = gv('num');
      if (num) out[String(num)] = {
        id: d.name.split('/').pop(),
        lanceAtual: Number(gv('lanceAtual')) || 0,
        arrematante: gv('arrematante') || '',
        vendido: gv('vendido') === true,
        pago: gv('pago') === true
      };
    }
    tk = j.nextPageToken || '';
  } while (tk);
  return out;
}

async function main() {
  var browser = await chromium.launch();
  var page = await browser.newPage();
  await page.goto('https://www.sodresantoro.com.br/materiais/lotes?term=porcelanato&sort=auction_date_init_asc', { waitUntil: 'domcontentloaded', timeout: 60000 });
  try {
    await page.waitForFunction(function () {
      return /Leilão\s+\d+\s*-\s*\d+/.test(document.body.innerText) && /Lance (inicial|atual)/.test(document.body.innerText);
    }, { timeout: 120000 });
  } catch (e) {
    console.log('AVISO: pagina da Sodre nao carregou os lotes (site pode ter mudado). Nada alterado.');
    await browser.close(); return;
  }
  await page.waitForTimeout(4000);
  var text = await page.evaluate(function () { return document.body.innerText; });
  await browser.close();

  var re = /Leilão\s+(\d{4,6})\s*-\s*(\d{1,4})[\s\S]*?Lance (atual|inicial)\s*\(R\$\)(?:\s*-\s*([^\n]+))?\s*\n+\s*([\d.]+,\d{2})/g;
  var achados = [], m;
  while ((m = re.exec(text))) {
    achados.push({
      num: m[1] + '-' + String(m[2]).padStart(3, '0'),
      tipo: m[3],
      arrem: (m[4] || '').trim(),
      valor: parseBRL(m[5])
    });
  }
  console.log('Site: ' + achados.length + ' lote(s) encontrado(s).');
  if (!achados.length) { console.log('AVISO: parser nao encontrou lotes. Nada alterado.'); return; }

  var lotes = await fetchLotes();
  var upd = 0, skip = 0, iguais = 0;
  for (var a of achados) {
    var l = lotes[a.num];
    if (!l) { skip++; continue; }
    if (l.vendido || l.pago) { skip++; continue; }
    if (a.tipo !== 'atual') { continue; }
    if (Math.abs(l.lanceAtual - a.valor) < 0.005 && l.arrematante === a.arrem) { iguais++; continue; }
    var body = { fields: { lanceAtual: { doubleValue: a.valor }, arrematante: { stringValue: a.arrem } } };
    var r2 = await fetch(B + '/lotes/' + l.id + '?key=' + KEY + '&updateMask.fieldPaths=lanceAtual&updateMask.fieldPaths=arrematante', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    if (r2.ok) { upd++; console.log('Atualizado ' + a.num + ': R$ ' + a.valor + (a.arrem ? ' (' + a.arrem + ')' : '')); }
    else { console.log('ERRO ao atualizar ' + a.num + ': ' + r2.status); }
  }
  console.log('Fim: ' + upd + ' atualizado(s), ' + iguais + ' sem mudanca, ' + skip + ' ignorado(s).');
}

main().catch(function (e) { console.error('Erro geral:', e && e.message); process.exit(0); });
