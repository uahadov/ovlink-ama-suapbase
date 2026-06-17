require('dotenv').config();
const nodemailer = require('nodemailer');

if (!process.env.SMTP_PASS) {
    console.error('SMTP_PASS bulunamadi!');
    process.exit(1);
}

if (!process.env.FROM_EMAIL) {
    console.error('FROM_EMAIL bulunamadi!');
    process.exit(1);
}

console.log('Email test baslatiliyor...');
console.log('FROM_EMAIL:', process.env.FROM_EMAIL);

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'mail.spaceship.com',
  port: Number(process.env.SMTP_PORT) || 465,
  secure: true,
  auth: {
    user: process.env.SMTP_USER || 'verify@ovlink.sbs',
    pass: process.env.SMTP_PASS,
  },
});

async function sendTestEmail() {
    try {
        console.log('\nEmail gonderiliyor...\n');
        const result = await transporter.sendMail({
            from: process.env.FROM_EMAIL,
            to: 'qorxusuzqorxaq@gmail.com',
            subject: 'Ovlink Test Email - Verification Code: 123456',
            text: 'Test mesaj - Dogrulama Kodu: 123456',
            html: `
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="utf-8">
                    <title>Ovlink Test Email</title>
                </head>
                <body style="font-family: Arial, sans-serif; padding: 20px; background-color: #f5f5f5;">
                    <div style="max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px;">
                        <h1 style="color: #2563eb;">Ovlink Test Email</h1>
                        <p>Bu bir test e-postasidir.</p>
                        <div style="background: #f0f9ff; padding: 20px; border-radius: 8px; margin: 20px 0;">
                            <p style="margin: 0; color: #1e40af; font-size: 14px;">DOGRULAMA KODU:</p>
                            <h2 style="margin: 10px 0; color: #2563eb; font-size: 36px; letter-spacing: 5px;">123456</h2>
                        </div>
                        <p>Email sistemi basariyla calisiyor!</p>
                        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
                        <p style="color: #6b7280; font-size: 12px;">2026 Ovlink. Developed by Ulvi Ahadov</p>
                    </div>
                </body>
                </html>
            `
        });
        console.log('Email basariyla gonderildi!');
        console.log('Message ID:', result.messageId);
        console.log('qorxusuzqorxaq@gmail.com adresini kontrol edin.');
    } catch (error) {
        console.error('Email gonderim hatasi!');
        console.error('Hata:', error.message || 'Bilinmeyen hata');
        console.error('Cozum onerileri:');
        console.error('1. SMTP bilgilerini kontrol edin');
        console.error('2. Spaceship mail hesabinizin aktif oldugundan emin olun');
        process.exit(1);
    }
}

sendTestEmail();
