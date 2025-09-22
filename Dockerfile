FROM nginx:alpine

# Cache busting - pass --build-arg CACHE_DATE=$(date) to force rebuild
ARG CACHE_DATE=unknown

# App files
COPY index.html /usr/share/nginx/html/
COPY style.css  /usr/share/nginx/html/
COPY script.js  /usr/share/nginx/html/

COPY seasons/ /usr/share/nginx/html/seasons/

# Copy JSON files explicitly (this should invalidate cache when files change)
COPY data_week_*.json /usr/share/nginx/html/

# Debug: List the copied files with timestamps
RUN ls -la /usr/share/nginx/html/data_week_*.json || echo "No data files found"

EXPOSE 80
