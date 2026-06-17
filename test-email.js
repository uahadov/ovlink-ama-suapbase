require('dotenv').config();
const { Resend } = require('resend');

if (!process.env.RESEND_API_KEY) {
    console.error('❌ RESEND_API_KEY bulunamadı!');
    console.error('Lütfen .env dosyasında RESEND_API_KEY tanımlı olduğundan emin olun.');
    process.exit(1);
}

if (!process.env.FROM_EMAIL) {
    console.error('❌ FROM_EMAIL bulunamadı!');
    console.error('Lütfen .env dosyasında FROM_EMAIL tanımlı olduğundan emin olun.');
    process.exit(1);
}

console.log('🔍 Email test başlatılıyor...');
console.log('📧 FROM_EMAIL:', process.env.FROM_EMAIL);
console.log('🔑 RESEND_API_KEY:', process.env.RESEND_API_KEY ? '✅ Tanımlı (gizli)' : '❌ Tanımsız');

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendTestEmail() {
    try {
        console.log('\n📤 Email gönderiliyor...\n');
        const result = await resend.emails.send({
            from: process.env.FROM_EMAIL,
            to: 'qorxusuzqorxaq@gmail.com',
            subject: 'Ovlink Test Email - Verification Code: 123456',
            text: 'Test mesaj - Doğrulama Kodu: 123456\n\nBu bir test e-postasıdır. Ovlink email sisteminin çalışıp çalışmadığını kontrol ediyoruz.',
            html: `
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="utf-8">
                    <title>Ovlink Test Email</title>
                </head>
                <body style="font-family: Arial, sans-serif; padding: 20px; background-color: #f5f5f5;">
                    <div style="max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px;">
                        <h1 style="color: #2563eb;">🎉 Ovlink Test Email</h1>
                        <p>Bu bir test e-postasıdır.</p>
                        <div style="background: #f0f9ff; padding: 20px; border-radius: 8px; margin: 20px 0;">
                            <p style="margin: 0; color: #1e40af; font-size: 14px;">DOĞRULAMA KODU:</p>
                            <h2 style="margin: 10px 0; color: #2563eb; font-size: 36px; letter-spacing: 5px;">123456</h2>
                        </div>
                        <p>Email sistemi başarıyla çalışıyor! ✅</p>
                        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
                        <p style="color: #6b7280; font-size: 12px;">© 2026 Ovlink. Developed by Ulvi Ahadov</p>
                    </div>
                </body>
                </html>
            `
        });
        console.log('✅ Email başarıyla gönderildi!');
        console.log('\n📊 Resend API Yanıtı:');
        console.log(JSON.stringify(result, null, 2));
        console.log('\n✨ Test başarılı! Email sistemi çalışıyor.');
        console.log('📬 Lütfen qorxusuzqorxaq@gmail.com adresini kontrol edin.');
    } catch (error) {
        console.error('❌ Email gönderim hatası!\n');
        console.error('Hata Detayları:');
        console.error('- Mesaj:', error.message || 'Bilinmeyen hata');
        console.error('- İsim:', error.name || 'Error');
        console.error('- Status Code:', error.statusCode || 'N/A');
        if (error.response) {
            console.error('- API Yanıtı:', JSON.stringify(error.response, null, 2));
        }
        console.error('\n🔍 Olası Nedenler:');
        console.error('1. Resend API key geçersiz veya süresi dolmuş');
        console.error('2. ovlink.sbs domain\'i Resend\'de doğrulanmamış');
        console.error('3. FROM_EMAIL adresi yanlış formatda');
        console.error('4. Resend hesabı askıya alınmış veya limit aşılmış');
        console.error('\n💡 Çözüm Önerileri:');
        console.error('1. Resend dashboard\'a giriş yapın: https://resend.com/domains');
        console.error('2. ovlink.sbs domain\'ini ekleyin ve DNS kayıtlarını doğrulayın');
        console.error('3. API key\'in doğru olduğundan emin olun');
        process.exit(1);
    }
}

sendTestEmail();
