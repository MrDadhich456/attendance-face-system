#!/bin/bash
# =============================================================================
# EC2 Setup Script for Attendance System
# Run this on a fresh Ubuntu 22.04/24.04 EC2 instance (t2.micro free tier)
#
# Usage:
#   chmod +x setup-ec2.sh
#   sudo ./setup-ec2.sh
# =============================================================================

set -e  # Exit on any error

echo "============================================"
echo "  Attendance System — EC2 Setup Script"
echo "============================================"
echo ""

# --- 1. System updates ---
echo "[1/7] Updating system packages..."
apt-get update -y && apt-get upgrade -y

# --- 2. Install Node.js 20 LTS ---
echo "[2/7] Installing Node.js 20 LTS..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
echo "Node.js $(node -v) installed"
echo "npm $(npm -v) installed"

# --- 3. Install PM2 globally ---
echo "[3/7] Installing PM2 process manager..."
npm install -g pm2
mkdir -p /var/log/pm2
chown ubuntu:ubuntu /var/log/pm2

# --- 4. Install and configure Nginx ---
echo "[4/7] Installing and configuring Nginx..."
apt-get install -y nginx

# --- 5. Clone or update the app ---
echo "[5/7] Setting up application..."
APP_DIR="/home/ubuntu/attendance-system"

if [ -d "$APP_DIR" ]; then
  echo "App directory exists. Pulling latest changes..."
  cd "$APP_DIR"
  sudo -u ubuntu git pull origin main
else
  echo "Cloning repository..."
  # IMPORTANT: Replace this URL with your actual repo URL
  sudo -u ubuntu git clone https://github.com/MrDadhich456/attendance-face-system.git "$APP_DIR"
  cd "$APP_DIR"
fi

# Install dependencies
echo "Installing Node.js dependencies..."
cd "$APP_DIR"
sudo -u ubuntu npm install --production

# --- 6. Configure Nginx ---
echo "[6/7] Configuring Nginx reverse proxy..."
cp "$APP_DIR/nginx.conf" /etc/nginx/sites-available/attendance
ln -sf /etc/nginx/sites-available/attendance /etc/nginx/sites-enabled/attendance
rm -f /etc/nginx/sites-enabled/default

# Update nginx.conf with correct app path
sed -i "s|/home/ubuntu/attendance-system|$APP_DIR|g" /etc/nginx/sites-available/attendance

# Test and reload nginx
nginx -t && systemctl reload nginx
systemctl enable nginx

# --- 7. Set up PM2 ---
echo "[7/7] Starting application with PM2..."

# Check if .env file exists
if [ ! -f "$APP_DIR/.env" ]; then
  echo ""
  echo "⚠️  WARNING: No .env file found!"
  echo "Create one at: $APP_DIR/.env"
  echo ""
  echo "Required variables:"
  echo "  DATABASE_URL=postgresql://user:pass@host:5432/dbname"
  echo "  DATABASE_SSL=true"
  echo "  ADMIN_PASSWORD=your_secure_password"
  echo "  NODE_ENV=production"
  echo "  PORT=3000"
  echo ""
  echo "Copy the example file:"
  echo "  cp $APP_DIR/.env.example $APP_DIR/.env"
  echo "  nano $APP_DIR/.env"
  echo ""
fi

# Start with PM2
cd "$APP_DIR"
sudo -u ubuntu pm2 start ecosystem.config.js
sudo -u ubuntu pm2 save

# Set PM2 to start on boot
env PATH=$PATH:/usr/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu

echo ""
echo "============================================"
echo "  ✅ Setup Complete!"
echo "============================================"
echo ""
echo "Your app is running at: http://$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || echo 'YOUR_EC2_PUBLIC_IP')"
echo ""
echo "Next steps:"
echo "  1. Create/edit .env file: nano $APP_DIR/.env"
echo "  2. Restart app: cd $APP_DIR && pm2 restart attendance-system"
echo "  3. Check logs: pm2 logs attendance-system"
echo "  4. Open port 80 in your EC2 Security Group (inbound rule)"
echo ""
echo "Useful commands:"
echo "  pm2 status              — check app status"
echo "  pm2 logs                — view live logs"
echo "  pm2 restart all         — restart after code changes"
echo "  sudo nginx -t           — test nginx config"
echo "  sudo systemctl reload nginx — reload nginx"
echo ""
