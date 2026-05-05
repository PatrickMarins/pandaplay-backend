# Firebase Storage setup

Uploads de APK, midias dos clientes e foto de perfil usam Firebase Storage.

## Variaveis no Railway

Configure no servico do backend:

```env
FIREBASE_STORAGE_BUCKET=seu-projeto.appspot.com
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
```

Alternativa ao JSON puro:

```env
FIREBASE_SERVICE_ACCOUNT_BASE64=base64-do-json-da-service-account
```

Se usar JSON puro, mantenha `private_key` com `\n` escapado, exatamente como vem no arquivo JSON.

## CORS do bucket

Para upload direto pelo navegador, aplique o CORS no bucket:

```powershell
gsutil cors set firebase-storage-cors.json gs://seu-projeto.appspot.com
```

O arquivo `firebase-storage-cors.json` ja libera:

- `https://pandaplay-frontend.vercel.app`
- `http://localhost:5173`

## Fluxos migrados

- `POST /api/admin/downloads/upload-url`: APK do painel admin
- `POST /api/media/upload-url`: cria URL assinada para midia do cliente
- `POST /api/media/complete-upload`: registra a midia no banco apos upload
- `POST /api/auth/photo`: foto de perfil

O banco Postgres continua sendo usado para metadados e URLs.
