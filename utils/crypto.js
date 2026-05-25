const crypto = require('crypto');

// Ensures we always have a 32-byte key
function getEncryptionKey() {
  const keyHex = process.env.ENCRYPTION_KEY;
  if (!keyHex) {
    throw new Error('ENCRYPTION_KEY is required in environment variables (must be 64 hex chars / 32 bytes).');
  }
  const keyBuffer = Buffer.from(keyHex, 'hex');
  if (keyBuffer.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be exactly 32 bytes (64 hex characters) long.');
  }
  return keyBuffer;
}

// Encrypt string to AES-256-GCM format: "iv:authTag:ciphertext"
function encryptAES256GCM(plainText) {
  if (plainText === null || plainText === undefined) return plainText;
  const text = plainText.toString();
  if (!text) return '';

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag().toString('hex');
  
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

// Decrypt AES-256-GCM string
function decryptAES256GCM(encryptedPayload) {
  if (!encryptedPayload) return encryptedPayload;
  
  const parts = encryptedPayload.split(':');
  if (parts.length !== 3) {
    // If it is not in the correct format, return as is (could be legacy plain text data)
    return encryptedPayload;
  }
  
  try {
    const key = getEncryptionKey();
    const [ivHex, authTagHex, encryptedHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('Decryption error:', err.message);
    // Return original on failure or handle appropriately
    return encryptedPayload;
  }
}

// Blind index for fast DB lookup (HMAC-SHA256)
function blindIndex(plainText) {
  if (!plainText) return plainText;
  const key = getEncryptionKey();
  return crypto.createHmac('sha256', key).update(plainText.toString().trim().toLowerCase()).digest('hex');
}

module.exports = {
  encryptAES256GCM,
  decryptAES256GCM,
  blindIndex
};
