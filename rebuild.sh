#!/bin/bash

# Stop container if running
docker stop heatmap 2>/dev/null || true

# Remove container if it exists
docker rm heatmap 2>/dev/null || true

# Build the image
docker build --no-cache -t heatmap-app .

# Run the container with JSON bind mount
docker run -d -p 8080:80 \
  --name heatmap heatmap-app
