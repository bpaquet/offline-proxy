#!/bin/sh -e

NGINX_HOME=$HOME/tmp/nginx
PID_FILE=$NGINX_HOME/logs/nginx.pid
if [ -f $PID_FILE ]; then
  kill `cat $PID_FILE`
fi

$NGINX_HOME/sbin/nginx -c `pwd`/nginx.conf