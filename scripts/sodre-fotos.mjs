// Robo de FOTOS v2: baixa imagens dos lotes no site da Sodre e anexa no Abadias.
// Age em lotes com linkSodre que nao tem fotos OU cuja captura anterior nao registrou fotosN
// (recaptura unica: espera a galeria carregar, deduplica por nome de arquivo e so sobrescreve
// quando encontra MAIS fotos que o banco).
import { chromium } from 'playwright';
import sharp from 'sharp';

var PROJECT = 'porcelarte-leiloes';
var KEY = 'AIzaSyCk5wE8UUvUGOTjEGzEGecCBFjRd4Am0ro';
var B = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents';
var MAX_LOTES = 50;

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
      for (var c2 of campos) { var x = f[c2]; if (x && x.stringValue !== undefined) o[c2] = x.stringValue; else if (x && x.booleanValue !== undefined) o[c2] = x.booleanValue; }
      out.push(o);
    }
    tk = j.nextPageToken || '';
  } while (tk);
  return out;
}

async function main() {
  var lotes = await listar('lotes', ['num', 'linkSodre']);
  var docFotos = {};
  (await listar('fotos_lotes', ['num', 'fotosN'])).forEach(function (f) { docFotos[String(f.num)] = (f.fotosN === undefined ? -1 : Number(f.fotosN)); });
  var alvos = lotes.filter(function (l) {
    if (!l.linkSodre) return false;
    var n = docFotos[String(l.num)];
    return n === undefined || n === -1; // sem doc, ou doc antigo sem fotosN (recaptura unica)
  }).slice(0, MAX_LOTES);
  console.log('Lotes para capturar/recapturar: ' + alvos.length + (alvos.length ? ' -> ' + alvos.map(function (a) { return a.num; }).join(', ') : ''));
  if (!alvos.length) { console.log('Nada a fazer.'); return; }

  var browser = await chromium.launch();
  var ctx = await browser.newContext({
    bypassCSP: true, locale: 'pt-BR', viewport: { width: 1366, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  });
  var page = await ctx.newPage();

  for (var l of alvos) {
    try {
      await page.goto(l.linkSodre, { waitUntil: 'domcontentloaded', timeout: 60000 });
      try { await page.waitForSelector('img[src*="photos.sodresantoro"]', { timeout: 30000 }); } catch (eW) { }
      await page.waitForTimeout(4000);
      await page.evaluate(function () { window.scrollBy(0, 700); });
      await page.waitForTimeout(2500);
      var srcs = await page.evaluate(function () {
        var out = {};
        document.querySelectorAll('img').forEach(function (im) {
          var s = im.currentSrc || im.src || '';
          if (!s || s.indexOf('http') !== 0) return;
          if (/logo|icon|favicon|banner|avatar/i.test(s)) return;
          if (/photos\.sodresantoro/i.test(s) || im.naturalWidth >= 350 || /s3|amazonaws|cloudfront|lote|lot_|auction/i.test(s)) {
            out[s.split('/').pop()] = s; // deduplica por nome de arquivo
          }
        });
        return Object.keys(out).sort().map(function (k) { return out[k]; }).slice(0, 8);
      });
      if (!srcs.length) { console.log(l.num + ': nenhuma imagem na pagina.'); continue; }
      var fotos = [], totalB = 0;
      for (var i = 0; i < srcs.length && fotos.length < 5; i++) {
        try {
          var resp = await page.request.get(srcs[i]);
          if (!resp.ok()) continue;
          var buf = Buffer.from(await resp.body());
          if (buf.length < 12000) continue;
          var out = await sharp(buf).rotate().resize({ width: 1000, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
          var b64 = 'data:image/jpeg;base64,' + out.toString('base64');
          if (totalB + b64.length > 850000) break;
          totalB += b64.length;
          fotos.push({ name: 'sodre_' + (fotos.length + 1) + '.jpg', dataURL: b64 });
        } catch (e2) { }
      }
      if (!fotos.length) { console.log(l.num + ': imagens pequenas/invalidas.'); continue; }
      var oldN = docFotos[String(l.num)];
      if (oldN !== undefined && oldN !== -1 && fotos.length <= oldN) { console.log(l.num + ': banco ja tem ' + oldN + ' foto(s), site deu ' + fotos.length + '. Mantido.'); continue; }
      var body = { fields: { num: { stringValue: String(l.num) }, fotosN: { stringValue: String(fotos.length) }, fotos: { arrayValue: { values: fotos.map(function (f) { return { mapValue: { fields: { name: { stringValue: f.name }, dataURL: { stringValue: f.dataURL } } } }; }) } } } };
      var r = await fetch(B + '/fotos_lotes/' + encodeURIComponent(String(l.num)) + '?key=' + KEY, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      console.log((r.ok ? 'FOTOS OK ' : 'ERRO ') + l.num + ': ' + fotos.length + ' foto(s)' + (oldN >= 0 ? ' (antes: ' + (oldN === -1 ? '?' : oldN) + ')' : '') + ', ' + Math.round(totalB / 1024) + ' KB');
    } catch (e) { console.log(l.num + ': erro ' + (e && e.message ? e.message.slice(0, 120) : e)); }
  }
  await browser.close();
  console.log('Fim.');
}

main().catch(function (e) { console.error('Erro geral:', e && e.message); process.exit(0); });
