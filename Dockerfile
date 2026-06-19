# --- Build Stage ---
FROM node:22-alpine AS builder

WORKDIR /usr/src/app

# Instala o pnpm globalmente
RUN npm install -g pnpm

# Copia arquivos de dependências
COPY package.json pnpm-lock.yaml ./

# Instala todas as dependências (incluindo devDependencies para build)
RUN pnpm install --frozen-lockfile

# Copia o restante do código fonte
COPY . .

# Compila a aplicação NestJS
RUN pnpm run build

# --- Runner Stage ---
FROM node:22-alpine AS runner

WORKDIR /usr/src/app

# Instala o pnpm globalmente
RUN npm install -g pnpm

# Variável de ambiente padrão para produção
ENV NODE_ENV=production

# Copia arquivos de dependências
COPY package.json pnpm-lock.yaml ./

# Instala apenas as dependências de produção
RUN pnpm install --prod --frozen-lockfile

# Copia a build compilada do estágio anterior
COPY --from=builder /usr/src/app/dist ./dist

# Expõe a porta em que o bot roda (padrão 5600 no .env)
EXPOSE 5600

# Comando para iniciar a aplicação
CMD ["node", "dist/main"]
