FROM node:20-alpine

WORKDIR /app

# Installation des dépendances système nécessaires pour node-vault
RUN apk add --no-cache dumb-init

# Copie des fichiers de dépendances
COPY package*.json ./

# Installation des dépendances Node.js (npm install au lieu de npm ci)
RUN npm install --omit=dev

# Copie du code source
COPY index.js ./

# Exposition du port
EXPOSE 3000

# Utilisation de dumb-init pour une gestion correcte des signaux
ENTRYPOINT ["dumb-init", "--"]

# Commande de démarrage
CMD ["node", "index.js"]