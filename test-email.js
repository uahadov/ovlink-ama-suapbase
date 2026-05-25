require('dotenv').config();
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendTestEmail() {
    try {
        const result = await resend.emails.send({
            from: process.env.FROM_EMAIL || 'Ovlink <onboarding@resend.dev>',
            to: 'qorxusuzqorxaq@gmail.com',
            subject: 'Ovlink Test - 123456',
            text: 'Test mesaj - kod: 123456',
            html: '<h1>Test E-posta</h1><p>Doğrulama Kodu: <strong>123456</strong></p>'
        });
        console.log('Başarılı:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.log('Hata:', error);
    }
}

sendTestEmail();
