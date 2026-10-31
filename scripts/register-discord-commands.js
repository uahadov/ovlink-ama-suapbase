require('dotenv').config();

const DISCORD_APP_ID = process.env.DISCORD_APP_ID || '';
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const API_BASE = 'https://discord.com/api/v10';

const commands = [
  {
    name: 'short',
    description: 'URLyi kisalt',
    options: [
      {
        name: 'url',
        description: 'Kisaltilacak URL',
        type: 3,
        required: true,
      },
      {
        name: 'alias',
        description: 'Ozel alias (sadece Pro)',
        type: 3,
        required: false,
      },
    ],
  },
  {
    name: 'stats',
    description: 'Link istatistiklerini gor (Pro)',
    options: [
      {
        name: 'kod',
        description: 'Link kisaltma kodu',
        type: 3,
        required: true,
      },
    ],
  },
  {
    name: 'mylinks',
    description: 'Son 10 linkini listele',
  },
  {
    name: 'link',
    description: 'Ovlink hesabini bagla',
  },
  {
    name: 'unlink',
    description: 'Ovlink hesabini ayir',
  },
  {
    name: 'help',
    description: 'Komut listesini goster',
  },
  {
    name: 'upgrade',
    description: 'Pro plan hakkinda bilgi al',
  },
  {
    name: 'language',
    description: 'Change the language of the bot / Botun dilini degistirin',
    options: [
      {
        name: 'lang',
        description: 'Choose language / Dil secin',
        type: 3,
        required: true,
        choices: [
          { name: '🇬🇧 English', value: 'en' },
          { name: '🇹🇷 Türkçe', value: 'tr' },
          { name: '🇦🇿 Azərbaycan', value: 'az' },
          { name: '🇷🇺 Русский', value: 'ru' }
        ]
      }
    ]
  },
  {
    name: 'lang',
    description: 'Change the language of the bot / Botun dilini degistirin',
    options: [
      {
        name: 'lang',
        description: 'Choose language / Dil secin',
        type: 3,
        required: true,
        choices: [
          { name: '🇬🇧 English', value: 'en' },
          { name: '🇹🇷 Türkçe', value: 'tr' },
          { name: '🇦🇿 Azərbaycan', value: 'az' },
          { name: '🇷🇺 Русский', value: 'ru' }
        ]
      }
    ]
  }
];

async function registerCommands() {
  if (!DISCORD_APP_ID || !BOT_TOKEN) {
    console.error('DISCORD_APP_ID ve DISCORD_BOT_TOKEN .env dosyasinda tanimli olmali.');
    process.exit(1);
  }

  const url = `${API_BASE}/applications/${DISCORD_APP_ID}/commands`;

  console.log(`[register] ${commands.length} komut register ediliyor...`);

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`[register] Hata (${res.status}):`, err);
    process.exit(1);
  }

  const data = await res.json();
  console.log(`[register] ${data.length} komut basariyla register edildi:`);
  data.forEach((cmd) => console.log(`  - /${cmd.name}: ${cmd.description}`));
}

registerCommands().catch((err) => {
  console.error('[register] Beklenmeyen hata:', err.message);
  process.exit(1);
});
