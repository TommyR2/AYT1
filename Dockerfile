FROM nginx:alpine

# App files
COPY index.html /usr/share/nginx/html/
COPY style.css  /usr/share/nginx/html/
COPY script.js  /usr/share/nginx/html/

# Week data (baked into the image)
COPY data_week_*.json /usr/share/nginx/html/

EXPOSE 80 
