// A valid, deterministic multi-page PDF for UI transport/pane tests.
module.exports = function pdfFixture(text = "Regression fixture", pages = 3) {
  const fontId = 3 + pages * 2;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${Array.from({length:pages},(_,i)=>`${3+i*2} 0 R`).join(" ")}] /Count ${pages} >>`];
  for (let i=0;i<pages;i++) {
    const stream = `BT /F1 18 Tf 40 150 Td (${text.replace(/[()\\]/g,"_")} page ${i+1}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${4+i*2} 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let body = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((o,i) => { offsets.push(Buffer.byteLength(body)); body += `${i+1} 0 obj\n${o}\nendobj\n`; });
  const start = Buffer.byteLength(body); body += `xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,"0")+" 00000 n \n").join("")}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(body);
};
