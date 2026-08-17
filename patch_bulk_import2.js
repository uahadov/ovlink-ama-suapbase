const fs = require('fs');
let s = fs.readFileSync('public/script.js', 'utf8');

if (!s.includes('bulkImportInput.addEventListener("input"')) {
    s = s.replace('if (bulkImportSubmit && bulkImportInput) {', 'if (bulkImportSubmit && bulkImportInput) {\n    bulkImportInput.addEventListener("input", () => {\n      bulkImportSubmit.disabled = false;\n      if (bulkImportMsg) bulkImportMsg.textContent = "";\n      if (bulkImportResults) bulkImportResults.classList.add("d-none");\n    });');
}

if (!s.includes('bulkImportInput.value = "";')) {
    s = s.replace('const okMsg = data.message || pickLang("Import tamamlandı.", "İçe aktarma tamamlandı.", "Import completed.");', 'const okMsg = data.message || pickLang("Import tamamlandı.", "İçe aktarma tamamlandı.", "Import completed.");\n        bulkImportInput.value = "";\n        bulkImportSubmit.disabled = true;');
}

fs.writeFileSync('public/script.js', s);
console.log('patched bulk import 2');
