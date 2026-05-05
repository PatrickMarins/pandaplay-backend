const { initializeApp, cert, applicationDefault, getApps } = require('firebase-admin/app');
const { getStorage } = require('firebase-admin/storage');

const parseServiceAccount = () => {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

  if (base64) {
    return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  }

  if (raw) {
    const account = JSON.parse(raw);
    if (account.private_key) {
      account.private_key = account.private_key.replace(/\\n/g, '\n');
    }
    return account;
  }

  return null;
};

const getFirebaseBucket = () => {
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
  if (!bucketName) {
    throw new Error('FIREBASE_STORAGE_BUCKET nao configurado');
  }

  if (!getApps().length) {
    const serviceAccount = parseServiceAccount();
    initializeApp({
      credential: serviceAccount ? cert(serviceAccount) : applicationDefault(),
      storageBucket: bucketName
    });
  }

  return getStorage().bucket(bucketName);
};

const buildFirebaseDownloadUrl = (bucketName, path, token) => {
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
};

module.exports = { getFirebaseBucket, buildFirebaseDownloadUrl };
