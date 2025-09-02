FROM nginx:alpine

# Copy static files into nginx web root
COPY index.html /usr/share/nginx/html/
COPY style.css /usr/share/nginx/html/
COPY script.js /usr/share/nginx/html/

# data.json will be mounted from host, not baked in
EXPOSE 80
