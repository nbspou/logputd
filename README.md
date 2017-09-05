# logputd
Stores logs received from remote hosts in local files and puts them on S3 storage for daily rotation

## Installation

Install logputd
```
sudo npm install -g logputd
```

Configure logputd
```
cd ~
mkdir .logputd
cd .logputd
wget https://raw.githubusercontent.com/nbspou/logputd/master/config.json
wget https://raw.githubusercontent.com/nbspou/logputd/master/storage.example.json
nano storage.example.json
mv storage.example.json storage.json
```

Run logputd
```
logputd
```

## Startup service

Install PM2 and start persistent service for the current user
```
sudo npm install -g pm2
sudo pm2 startup -u $USER
```

Startup persistent logputd service under current user
```
pm2 start logputd
pm2 save
```

## Upgrade

Upgrade packages and restart service
```
sudo npm upgrade -g pm2
sudo npm upgrade -g logputd
pm2 restart logputd
```