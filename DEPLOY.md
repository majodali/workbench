# Deploying (local)

Deploy from your machine with your own AWS credentials. For hands-off deploys
from GitHub, see **[docs/CI_DEPLOY.md](./docs/CI_DEPLOY.md)** instead.

## 1. Prerequisites

- An **AWS account** and the **AWS CLI** configured (`aws sts get-caller-identity`).
- **Node.js 20+**.
- Either an **existing site bucket** to deploy into (`existing-bucket` mode) or
  nothing at all (`cloudfront` mode provisions its own hosting; optionally a
  Route 53 custom domain — then deploy in **`us-east-1`**).

## 2. Install + configure

```bash
npm install
cp infra/.env.example infra/.env    # then edit infra/.env
```

The same `infra/.env` drives both the CDK stack and the frontend build's base
path — see the comments in `.env.example` for each variable.

## 3. Bootstrap (first time per account/region)

```bash
cd infra
npx cdk bootstrap
cd ..
```

## 4. Deploy

```bash
npm run deploy
```

This builds the frontend (with the base path matching your hosting mode) and
runs `cdk deploy`. The stack outputs include the site URL.

## Tear down

`cloudfront` mode: `npm run destroy --workspace infra` removes everything the
stack created. `existing-bucket` mode: the stack never owns your bucket; the
deployed files stay under `SITE_PATH_PREFIX` until you delete them.
