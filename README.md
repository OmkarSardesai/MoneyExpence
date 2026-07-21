# Finora Expense Tracker

A professional expense tracking app built with Node.js, Express, MySQL, HTML, CSS, and JavaScript.

## Features
- Landing page with polished UI
- Login and registration
- Protected dashboard
- Expense entry form
- Recent expenses table
- Category pie chart
- Monthly trend chart

## Setup
1. Install dependencies:
   `npm install`
2. Make sure MySQL is running (or set up a Cloud MySQL database).
3. Update the database settings in `.env` if needed.
4. Start the app:
   `npm start`
5. Open http://localhost:3000

## Deploying to Render & Cloud MySQL

### Step 1: Create a Free Cloud MySQL Database
Since Render only provides free PostgreSQL natively, use a free cloud MySQL provider:
- **TiDB Cloud** (Recommended - 5GB free, 100% MySQL compatible) -> [tidbcloud.com](https://tidbcloud.com)
- **Aiven for MySQL** (1GB free) -> [aiven.io](https://aiven.io)
- **Railway** -> [railway.app](https://railway.app)

Copy your connection string (`mysql://user:password@host:port/dbname`) or individual host/user/password details from the cloud provider dashboard.

### Step 2: Deploy to Render
1. Push your repository to **GitHub**.
2. Go to [Render Dashboard](https://dashboard.render.com/) and click **New -> Web Service**.
3. Connect your GitHub repository.
4. Set the following details:
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
5. Under **Environment Variables**, add:
   - `DATABASE_URL` = `<your_cloud_mysql_connection_string>` *(or set `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_PORT` individually)*
   - `SESSION_SECRET` = `<a_random_secret_string>`
   - `DB_SSL` = `true`
6. Click **Create Web Service**. Your app will automatically connect and create required database tables!

