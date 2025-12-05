#!/bin/sh
echo "window._env_ = { VITE_BACKEND_URL: '${VITE_BACKEND_URL}' };" > /usr/share/nginx/html/env-config.js
nginx -g "daemon off;"
