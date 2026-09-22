# @Cloud Sign-up System - Render Deployment Guide

当前生产发布使用现有 Render backend/frontend 服务和 Atlas Free 集群；具体 Alumni Network 发布顺序、
数据库确认与迁移命令以 [Alumni Network 运行说明](ALUMNI_NETWORK_OPERATIONS.md) 为准。
下方创建新服务的步骤仅供首次搭建参考，不用于本次发布。

Note on terminology: when reviewing UI copy and logs, "Leader" refers to the System Authorization Level, while the user-facing @Cloud status label is “@Cloud Co-worker.” See `docs/TERMINOLOGY.md`.

## Prerequisites

✅ Project synced to GitHub main branch  
✅ Render account logged in  
✅ MongoDB Atlas account (for production database)

## Step 1: Prepare Environment Variables

### Backend Environment Variables (Set in Render Dashboard)

**Database Configuration:**

```
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/atcloud_signup_production
```

**Security Secrets (Generate secure random strings):**

```bash
# Generate these using: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
JWT_ACCESS_SECRET=<64-char-random-string>
JWT_REFRESH_SECRET=<64-char-random-string>
SESSION_SECRET=<64-char-random-string>
ALUMNI_CONTACT_LOOKUP_KEY_V1=<32-random-bytes-as-unpadded-base64url>
ALUMNI_INVITATION_TOKEN_KEY_V1=<different-32-random-bytes-as-unpadded-base64url>
```

**Application Configuration:**

```
NODE_ENV=production
PORT=10000
FRONTEND_URL=https://at-cloud-sign-up-system.onrender.com
JWT_ACCESS_EXPIRE=3h
JWT_REFRESH_EXPIRE=7d
BCRYPT_ROUNDS=12
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
MONGO_TRANSACTIONS_REQUIRED=true
NOTIFICATION_OUTBOX_ENABLED=true
```

**Email Configuration:**

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
EMAIL_FROM="@Cloud Ministry" <your-email@gmail.com>
SYSTEM_EMAIL=ops@yourdomain.org
```

### Frontend Environment Variables

```
VITE_API_URL=https://your-backend-url.onrender.com
NODE_ENV=production
```

## Step 2: MongoDB Atlas Setup

1. **Create MongoDB Atlas Cluster:**

   - Go to [MongoDB Atlas](https://cloud.mongodb.com/)
   - Select the approved Atlas Free cluster for production
   - Use an Atlas replica-set or sharded deployment with transaction support
   - Create database user with read/write permissions
   - 按现有 Render 出站连接要求维护 Atlas IP access list

2. **Get Connection String:**
   - In Atlas dashboard, click "Connect"
   - Choose "Connect your application"
   - Copy the connection string
   - Replace `<password>` with your database user password
   - Replace `<dbname>` with `atcloud_signup_production`

## Step 3: Deploy Backend Service

1. **Create New Web Service in Render:**

   - Go to Render Dashboard
   - Click "New +" → "Web Service"
   - Connect your GitHub repository
   - Choose the repository: `at-Cloud-sign-up-system`

2. **Configure Backend Service:**

   ```
   Name: atcloud-backend
   Environment: Node
   Region: Choose closest to your users
   Branch: main
   Root Directory: repository root
   Build Command: npm ci --include=dev && npm run build --workspace=@atcloud/shared-time && npm run build --workspace=atcloud-signup-system-backend
   Start Command: npm start --workspace=atcloud-signup-system-backend
   ```

3. **Set Environment Variables:**

   - In the service settings, add all backend environment variables listed in Step 1
   - ⚠️ **Important:** Use the "Secret File" option for sensitive values like JWT secrets

4. **Advanced Settings:**
   ```
   Auto-Deploy: Yes (deploy on git push)
   Health Check Path: /api/readiness
   ```

## Step 4: Deploy Frontend Service

1. **Create Static Site in Render:**

   - Click "New +" → "Static Site"
   - Connect same GitHub repository
   - Choose branch: main

2. **Configure Frontend Service:**

   ```
   Name: atcloud-frontend
   Root Directory: repository root
   Build Command: npm ci --include=dev && npm run build --workspace=@atcloud/shared-time && npm run build --workspace=frontend
   Publish Directory: frontend/dist
   ```

3. **Set Environment Variables:**
   - Add frontend environment variables from Step 1
   - Set `VITE_API_URL` to your backend service URL

## Step 5: Update Frontend API URL

After backend is deployed, update the frontend environment variable:

1. Get your backend service URL from Render dashboard
2. Update `VITE_API_URL` in frontend service settings
3. Trigger a frontend rebuild

## Step 6: Verify Deployment

### Backend Health Check

```bash
curl https://your-backend-url.onrender.com/api/readiness
```

Expected response: `{"status": "ok", "timestamp": "..."}`

### Frontend Access

Visit your frontend URL and verify:

- ✅ Site loads without errors
- ✅ Can navigate between pages
- ✅ API calls work (check browser dev tools)

### Database Connection

Check backend logs in Render dashboard for:

- ✅ "Connected to MongoDB" message
- ✅ MongoDB transaction capability verification
- ✅ Notification outbox worker startup when versioned delivery handlers are enabled
- ❌ No connection errors

## Step 7: Configure Custom Domain (Optional)

1. **Add Custom Domain in Render:**

   - In service settings → "Custom Domains"
   - Add your domain (e.g., `api.yourchurch.com` for backend)
   - Follow DNS configuration instructions

2. **Update Environment Variables:**
   - Update `FRONTEND_URL` in backend service
   - Update `VITE_API_URL` in frontend service
   - Redeploy both services

## Troubleshooting

### Common Issues:

**Build Failures:**

- Check build logs for missing dependencies
- Ensure all TypeScript types are in `dependencies`, not `devDependencies`

**Runtime Errors:**

- Check service logs in Render dashboard
- Verify all environment variables are set correctly
- Ensure MongoDB connection string is correct
- Ensure SYSTEM_EMAIL is set (recommended). If omitted, backend falls back to SMTP_USER. In test env, all emails are skipped intentionally.

**CORS Issues:**

- Verify `FRONTEND_URL` matches your frontend domain
- Check that frontend is making requests to correct backend URL

**Database Connection Issues:**

- Verify MongoDB Atlas cluster is running
- Check IP whitelist settings in Atlas
- Ensure connection string format is correct

### Useful Commands:

**Generate Secure Secrets:**

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

**Test API Locally:**

```bash
# Test backend health
curl http://localhost:5001/api/health

# Test with production API
curl https://your-backend-url.onrender.com/api/health
```

## Production Considerations

1. **Monitoring:**

   - Set up Render service monitoring
   - Configure alerts for service downtime
   - Monitor database performance in Atlas

2. **Security:**

   - Regularly rotate JWT secrets
   - Monitor for unusual API usage
   - Keep dependencies updated

3. **Performance:**
   - Monitor response times
   - Consider upgrading to paid plans for better performance
   - Implement caching strategies if needed

## Next Steps

After successful deployment:

- [ ] Test all user flows (signup, login, event creation, etc.)
- [ ] Set up monitoring and alerts
- [ ] Update documentation with production URLs
- [ ] Train administrators on production system

---

## Event Reminder Scheduler and Locking (Production)

This section consolidates production deployment notes for the Event Reminder Scheduler and locking modes.

### Runtime flags

- SCHEDULER_ENABLED
  - true: Start EventReminderScheduler on this process
  - false/unset: Do not start the scheduler on this process
  - Default behavior: enabled in non-production environments; requires explicit true in production.
- SINGLE_INSTANCE_ENFORCE
  - true: Fail-fast if multiple backend processes are detected while using in-memory coordination
  - false (default): Warn only
- WEB_CONCURRENCY / PM2_CLUSTER_MODE / NODE_APP_INSTANCE
  - Used to infer worker concurrency when SINGLE_INSTANCE_ENFORCE is enabled
- MONGO_TRANSACTIONS_REQUIRED
  - true: Verify replica-set/sharded transaction capability during startup
- NOTIFICATION_OUTBOX_ENABLED
  - true: Start durable notification delivery when at least one versioned handler is registered

### Render setup (single Web Service)

The backend Web Service serves HTTP and Socket.IO and runs scheduled work:

- `SCHEDULER_ENABLED=true`
- `SINGLE_INSTANCE_ENFORCE=true`
- `WEB_CONCURRENCY=1`
- `MONGO_TRANSACTIONS_REQUIRED=true`
- `NOTIFICATION_OUTBOX_ENABLED=true`
- Instances: 1

Bootstrap logic summary:

- Production: enabled only when `SCHEDULER_ENABLED === "true"`.
- Development: enabled unless `SCHEDULER_ENABLED === "false"`.
- Test: disabled.

### Health and Ops endpoints

- GET `/api/system/scheduler` — scheduler status snapshot
- POST `/api/system/scheduler/manual-trigger` — admin-only one-off run trigger (useful after enabling the worker)

Sample scheduler status response:

```json
{
  "success": true,
  "schedulerEnabled": false,
  "status": {
    "isRunning": false,
    "uptime": 0,
    "runs": 0
  },
  "timestamp": "2025-08-31T12:34:56.000Z"
}
```

Field notes:

- `schedulerEnabled`: whether this process is configured to start the scheduler (matches bootstrap logic)
- `status.isRunning`: whether the scheduler instance is currently running

### Option B (distributed lock — future)

If you later enable a distributed lock around EventReminderScheduler:

- Expose `lockOwner` and `lockExpiresAt` from the scheduler health endpoint for visibility.
- Keep the Background Worker at 1 instance unless you explicitly want failover; the distributed lock prevents overlap, not duplicate startup unless guarded.

### Troubleshooting (scheduler)

- Scheduler didn’t start in production:
  - Ensure `SCHEDULER_ENABLED=true` on the backend Web Service
  - Check logs for disabled message or lock warnings
- Multiple workers with in-memory lock:
  - Set `SINGLE_INSTANCE_ENFORCE=true` to fail-fast
  - Reduce `WEB_CONCURRENCY` to 1 or disable cluster/PM2 modes
