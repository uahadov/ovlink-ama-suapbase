const fs = require('fs');
let s = fs.readFileSync('public/script.js', 'utf8');

// Replace the finally block.
// Let's use a regex that matches the try/catch/finally for bulkImportSubmit explicitly.
// Or just replace the string exactly.

const searchString = `      } catch (err) {
        const msg = (currentLang === "tr" ? "Hata: " : (currentLang === "en" ? "Error: " : "Xəta: ")) + err.message;
        if (bulkImportMsg) {
          bulkImportMsg.className = "small text-danger mt-2";
          bulkImportMsg.textContent = msg;
        } else {
          alert(msg);
        }
      } finally {
        bulkImportSubmit.disabled = false;
      }`;

const replaceString = `      } catch (err) {
        const msg = (currentLang === "tr" ? "Hata: " : (currentLang === "en" ? "Error: " : "Xəta: ")) + err.message;
        if (bulkImportMsg) {
          bulkImportMsg.className = "small text-danger mt-2";
          bulkImportMsg.textContent = msg;
        } else {
          alert(msg);
        }
        bulkImportSubmit.disabled = false; // Enable ONLY on error
      } finally {
        // success disables it, input change enables it.
      }`;

if (s.includes(searchString)) {
    s = s.replace(searchString, replaceString);
    fs.writeFileSync('public/script.js', s);
    console.log('Successfully patched script.js');
} else {
    // maybe it has \r\n instead of \n
    const searchStringCrLf = searchString.replace(/\n/g, '\r\n');
    const replaceStringCrLf = replaceString.replace(/\n/g, '\r\n');
    if (s.includes(searchStringCrLf)) {
        s = s.replace(searchStringCrLf, replaceStringCrLf);
        fs.writeFileSync('public/script.js', s);
        console.log('Successfully patched script.js (CRLF)');
    } else {
        console.log('Could not find the target string to replace.');
    }
}
