var
  http = require('http'),
  fs = require('fs'),
  path = require('path'),
  mkdirp = require('mkdirp'),
  util = require('util'),
  log = require('log4node'),
  url = require('url'),
  net = require('net'),
  crypto = require('crypto'),
  events = require('events'),
  spawn = require('child_process').spawn;
  sprintf = require('sprintf').sprintf;

http.globalAgent.maxSockets = 100;

var argv = require('optimist').argv;

var port = argv.port || 3128;

log.setLogLevel('notice');

if (argv.log_file) {
  log.reconfigure({file: argv.log_file, level: argv.log_level});
}
else if (argv.log_level) {
  log.reconfigure({level: argv.log_level});
}

var http_proxy = undefined;
if (argv.http_proxy) {
  http_proxy = url.parse(argv.http_proxy);
}

function formatSize(n) {
  if (!n) {
    return 'undefined';
  }
  if (n < 1000) {
    return n;
  }
  n = n / 1000;
  if (n < 1000) {
    return sprintf('%0.3f k', n);
  }
  n = n / 1000;
  if (n < 1000) {
    return sprintf('%0.3f M', n);
  }
  n = n / 1000;
  return sprintf('%0.3f G', n);
}

function log_operation(c) {
  process.stdout.write(c || '.');
}

function file_exist(filename, exist, not_exist) {
  fs.stat(filename, function(err, stats) {
    if (err) {
      not_exist(filename);
    }
    else {
      exist(filename, stats);
    }
  });
}

var headers_to_copy_from_disk = [
  'Content-Length',
  'Content-Type',
  'Last-Modified',
  'Expires',
  'Etag',
  'Cache-Control',
  'Server',
];

var proxy_map = {
  302: function(result, ctx) {
    fs.writeFile(ctx.directory + "/302", result.headers.location, function(err) {
      if (err) {
        log.error("Unable to write file " + ctx.directory + "/302 : " + err);
        ctx.events.emit('error');
        return;
      }
      ctx.events.emit('no_body');
    });
  },
  301: function(result, ctx) {
    fs.writeFile(ctx.directory + "/301", result.headers.location, function(err) {
      if (err) {
        log.error("Unable to write file " + ctx.directory + "/301 : " + err);
        ctx.events.emit('error');
        return;
      }
      ctx.events.emit('no_body');
    });
  },
  404: function(result, ctx) {
    fs.writeFile(ctx.directory + "/404", "", function(err) {
      if (err) {
        log.error("Unable to write file " + ctx.directory + "/404 : " + err);
        ctx.events.emit('error');
        return;
      }
      ctx.events.emit('no_body');
    });
  },
  200: function(result, ctx) {
    var length = result.headers['content-length'];
    log.notice("Start receiving data for " + ctx.directory + ", Content-Length " + formatSize(length));
    fs.writeFile(ctx.directory + "/200.headers", JSON.stringify(result.headers), function(err) {
      if (err) {
        log.error("Unable to write headers file " + ctx.directory + "/200.headers: " + err);
        ctx.events.emit('error');
        return;
      }
    });
    var stream = fs.createWriteStream(ctx.directory + "/200.temp", {flags : 'w'});
    ctx.counter = 0;
    stream.on('error', function(err) {
      log.error("Unable to write file " + ctx.directory + "/200.temp: " + err);
    });
    stream.on('open', function() {
      ctx.status = 'streaming';
      ctx.result_headers = result.headers;
      ctx.filename = ctx.directory + "/200.temp";
      ctx.events.emit('streaming', result.headers);
    });
    result.on('data', function(chunk) {
      ctx.counter += chunk.length;
      log.info('Received ' + ctx.directory + ': ' + formatSize(ctx.counter) + '/' + formatSize(length));
      stream.write(chunk);
      ctx.events.emit('data');
    });
    result.on('end', function() {
      stream.end();
      log.notice("End of proxy request ok " + ctx.directory + ", size " + formatSize(ctx.counter));
      setTimeout(function() {
        fs.rename(ctx.directory + "/200.temp", ctx.directory + "/200", function(err) {
          if (err) {
            log.error("Unable to rename file to " + ctx.directory + "/200: " + err);
            ctx.events.emit('error');
            return;
          }
          ctx.events.emit('end', ctx.counter, ctx.directory + "/200");
      });
      }, 200);
    });
    result.on('close', function() {
      //HTTP Client never emit this event
    });
  }
}

function copyHeadersIfExists(headers, from_headers, callback) {
  headers.forEach(function(h) {
    var hh = from_headers[h.toLowerCase()];
    if (hh) {
      callback(h, hh);
    }
  });
}

var current_request = {}

function proxy(response, headers, parsed_url, directory, body_chunks) {
  if (!current_request[directory]) {
    current_request[directory] = {
      status: 'wait_headers',
      events: new events.EventEmitter,
      headers: headers,
      parsed_url: parsed_url,
      directory: directory,
      body_chunks: body_chunks,
    }
    current_request[directory].events.on('error', function() {
      delete current_request[directory];
    });
    current_request[directory].events.on('no_body', function() {
      delete current_request[directory];
    });
    current_request[directory].events.on('end', function() {
      delete current_request[directory];
    });
    process.nextTick(function() {
      run_proxy_request(current_request[directory]);
    });
  }
  current_request[directory].events.on('error', function() {
    response.statusCode = 500;
    response.end();
  });
  var ctx = current_request[directory];
  var fd = undefined;
  var current = 0;
  var buffer_in = new Buffer(64 * 1024);
  var stop = false;
  var read_data = function() {
    fs.read(fd, buffer_in, 0, buffer_in.length, current, function(err, bytesRead, buffer_in) {
      if (err) {
        log.error('Error reading', filename, err);
        fd.close();
        return;
      }
      if (stop) {
        return;
      }
      current += bytesRead;
      if (bytesRead > 0) {
        log.debug('Sent', bytesRead, 'from temp file, current', current, ' for', ctx.directory);
        var buffer_out = new Buffer(bytesRead);
        buffer_in.copy(buffer_out, 0, 0, bytesRead);
        response.write(buffer_out.slice(0, bytesRead));
      }
      if (bytesRead == buffer_in.length) {
        read_data();
      }
      else {
       ctx.events.once('data', read_data);
      }
    });
  };
  var start_streaming = function() {
    log.info('Starting streaming', ctx.directory);
    copyHeadersIfExists(headers_to_copy_from_disk, ctx.result_headers, function(k, v) {response.setHeader(k, v)});
    fs.open(ctx.filename, 'r', function(err, file_fd) {
      if (err) {
        response.statusCode = 500;
        response.end();
        log.error('Unable to open file for reading', ctx.filename, err);
      }
      fd = file_fd;
      log.debug('File opened', ctx.filename);
      ctx.events.once('data', read_data);
    });
    ctx.events.on('end', function(size, filename) {
      fs.close(fd);
      stop = true;
      if (current != size) {
        log.info('Have sent to client', current, 'expected', size, ', getting data from', filename, 'request', ctx.directory);
        fs.open(filename, 'r', function(err, fd) {
          if (err) {
            log.error('Unable to open file', filename, err);
            return;
          }
          var to_be_read = size - current;
          var buffer_in = new Buffer(64 * 1024);
          var r = function() {
            fs.read(fd, buffer_in, 0, buffer_in.length, current, function(err, bytesRead, buffer_in) {
              if (err) {
                log.error('Error reading', filename, err);
                return;
              }
              to_be_read -= bytesRead;
              current += bytesRead;
              log.debug('Sent', bytesRead, 'from real file, current', current, 'for', ctx.directory);
              var buffer_out = new Buffer(bytesRead);
              buffer_in.copy(buffer_out, 0, 0, bytesRead);
              response.write(buffer_out);
              if (to_be_read == 0) {
                log.info('All data sent to client', ctx.directory);
                response.end();
                fs.close(fd);
                return;
              }
              if (bytesRead != buffer_in.length) {
                log.error('Wrong reading length', bytesRead, 'exptected', buffer_in.length, 'remaining', to_be_read, 'reading position', current - bytesRead);
                return;
              }
              r();
            })
          };
          r();
        })
      }
      else {
        log.info('All data has been sent to client from temp file', ctx.directory)
        fs.close(fd);
        response.end();
      }
    });
  };
  if (ctx.status == 'wait_headers') {
    log.info('Waiting headers for', ctx.directory);
    ctx.events.on('no_body', function() {
      process_req(response, headers, parsed_url, directory, body_chunks, function() {
        response.statusCode = 500;
        response.end();
        log.error('Internal error, no file found after proxy request', ctx.directory);
      });
    });
    ctx.events.on('streaming', function() {
      start_streaming();
    });
  }
  else {
    start_streaming();
  }
}

function run_proxy_request(ctx) {
  log.debug("Create directory " + ctx.directory);
  mkdirp(ctx.directory, function(err) {
    if (err) {
      log.error("Unable to create directory " + ctx.directory + " : " + err);
      ctx.events.emit('error');
      return;
    }
    log.debug("Directory created " + ctx.directory);
    log.info("Start proxy request " + ctx.directory);
    if (http_proxy) {
      var full_path = ctx.parsed_url.protocol + '//' + ctx.parsed_url.hostname;
      if (ctx.parsed_url.port) {
        full_path += ':' + ctx.parsed_url.port;
      }
      full_path += ctx.parsed_url.path;
      ctx.parsed_url.path = full_path;
      ctx.parsed_url.protocol = http_proxy.protocol;
      ctx.parsed_url.hostname = http_proxy.hostname;
      ctx.parsed_url.port = http_proxy.port;
    }
    if (ctx.body_chunks) {
      ctx.parsed_url.method = 'POST';
      ctx.parsed_url.headers = {};
      copyHeadersIfExists([
        'Content-Type',
        'Accept',
        'User-Agent',
        'Content-Encoding',
        'Accept-Encoding',
        'Content-length',
        ], ctx.headers, function(k, v) {ctx.parsed_url.headers[k] = v;});
    }
    var proxy_req = http.request(ctx.parsed_url, function(result) {
      var f = proxy_map[result.statusCode];
      if (!f) {
        log.notice("Wrong return code " + result.statusCode + " for proxy request  " + ctx.directory);
        ctx.events.emit('error');
        return;
      }
      f(result, ctx);
    });
    proxy_req.on('error', function(e) {
      log.error("Error while proxy request " + ctx.directory + " : " + e);
      ctx.events.emit('error');
    });
    if (ctx.body_chunks) {
      ctx.body_chunks.forEach(function(chunk) {
        proxy_req.write(chunk);
      })
    }
    proxy_req.end();
  });
}

function send_redirect(response, code, filename) {
  fs.readFile(filename, function(err, data) {
    if (err) {
      log.error("Unable to read file " + filename);
      response.statusCode = 500;
      response.end();
      return;
    }
    response.statusCode = code;
    response.setHeader("Location", data);
    response.end();
    log_operation();
  });
}

function streamFile(filename, response) {
  var stream = fs.createReadStream(filename, { flags: 'r', bufferSize: 64 * 1024});
  stream.pipe(response);
  stream.on('error', function(err) {
    log.error("Unable to read file " + filename + " : " + err);
    response.statusCode = 500;
    response.end();
  }).on('close', function() {
    log_operation();
    // Nothing to do
  });
}

var process_map = {
  301: function(response, headers, filename, stats) {
    send_redirect(response, 301, filename);
  },
  302: function(response, headers, filename, stats) {
    send_redirect(response, 302, filename);
  },
  404: function(response, headers, filename, stats) {
    log.info("Return 404 for request " + filename);
    response.statusCode = 404;
    response.end();
    log_operation();
  },
  200: function(response, headers, filename, stats) {
    file_exist(filename + '.headers', function(filename2, stats) {
      fs.readFile(filename + '.headers', function(err, data) {
        if (err) {
          log.error('Unable to read ' + filename + '.headers file:' + err);
          response.statusCode = 500;
          response.end();
          return;
        }
        orig_headers = JSON.parse(data.toString());
        if (headers['if-modified-since'] && orig_headers['last-modified']) {
          if_modified = Date.parse(headers['if-modified-since']);
          last_modified = Date.parse(orig_headers['last-modified']);
          if (if_modified >= last_modified) {
            log.debug("Return 304 for request " + filename);
            response.statusCode = 304;
            response.end();
            log_operation(':');
            return;
          }
        }
        copyHeadersIfExists(headers_to_copy_from_disk, orig_headers, function(k, v) {response.setHeader(k, v)});
        streamFile(filename, response);
      });
    }, function() {
      response.setHeader('Content-Length', stats.size);
      streamFile(filename, response);
    });
  }
}

var responses = [];
for(var i in process_map) {
  responses.push(i);
}

function process_req(response, headers, parsed_url, directory, body_chunks, not_found) {
  process_req_internal(responses.slice(0), response, headers, parsed_url, directory, body_chunks, not_found);
}

function process_req_internal(l, response, headers, parsed_url, directory, body_chunks, not_found) {
  if (l.length == 0) {
    return not_found(response, headers, parsed_url, directory, body_chunks);
  }
  var code = l.shift();
  log.debug('Searching', code, 'for', directory);
  file_exist(directory + '/' + code, function(filename, stats) {
    process_map[code](response, headers, filename, stats);
  }, function(filename) {
    process_req_internal(l, response, headers, parsed_url, directory, body_chunks, not_found);
  });
}

var current_git_clone = {}

function extract_git_path(string) {
  if (path.basename(string).match(/\.git$/)) {
    return string;
  }
  var dirname = path.dirname(string);
  return dirname == string ? null : extract_git_path(dirname);
}

function process_git_request(response, url, directory) {
  var git_repo_path = extract_git_path(directory);
  if (!git_repo_path) {
    log.error('Unable to extract git path ' + directory);
    response.statusCode = 500;
    response.end();
    return;
  }
  var serve_static_file = function(response) {
    file_exist(directory, function() {
      var s = fs.createReadStream(directory);
      response.statusCode = 200;
      s.pipe(response);
    }, function() {
      log.debug('Git file not found', directory);
      response.statusCode= 404;
      response.end();
    });
  };
  log.debug('Serving git request on repo', git_repo_path, 'file', directory);
  fs.exists(git_repo_path, function(exists) {
    if (exists && !current_git_clone[git_repo_path]) {
      serve_static_file(response);
    }
    else {
      if (!current_git_clone[git_repo_path]) {
        var git_repo_url = extract_git_path(url);
        if (!git_repo_url) {
          log.error('Unable to extract git path ' + url);
          response.statusCode = 500;
          response.end();
          return;
        }
        current_git_clone[git_repo_path] = new events.EventEmitter;
        log.notice('Cloning ' + git_repo_url + ' to ' + git_repo_path);
        var command = '';
        if (argv.http_proxy) {
          command += 'export http_proxy=' + argv.http_proxy + ' && ';
        }
        command += 'git clone --bare ' + git_repo_url + ' ' + git_repo_path + ' && cd ' + git_repo_path + ' && git update-server-info';
        var child = spawn('/bin/sh', ['-c', command]);
        log.debug('Launching command', command);
        child.on('exit', function(code) {
          log.debug('Command result', code);
          if (code == 0) {
            log.notice('Git clone ok', git_repo_url);
            current_git_clone[git_repo_path].emit('end');
          }
          else {
            log.info('Wrong return code for command', command, ':', code);
            current_git_clone[git_repo_path].emit('error');
          }
          delete current_git_clone[git_repo_path];
        });
      }
      current_git_clone[git_repo_path].on('end', function() {
        serve_static_file(response);
      });
      current_git_clone[git_repo_path].on('error', function() {
        response.statusCode = 500;
        response.end();
        return;
      });
    }
  });
}

http.createServer(function (request, response) {
  if (request.method != 'GET' && request.method != 'POST') {
    response.statusCode = 405;
    response.end();
    return;
  }
  var parsed_url = url.parse(request.url);
  if (! parsed_url) {
    log.error("Unable to parse url " + request.url);
    response.statusCode = 500;
    response.end();
    return;
  }
  if (request.method == 'GET' && parsed_url.path == '/reload_all_git_repos') {
    var command = '';
    if (argv.http_proxy) {
      command += 'export http_proxy=' + argv.http_proxy + ' && ';
    }
    command += 'cd storage && export home_dir=`pwd`; for i in `find . -name "packed-refs"`; do echo "Reloading `dirname $i`" && cd $home_dir && cd `dirname $i` && git fetch -q origin || exit 1; done && echo "OK";';
    var child = spawn('/bin/sh', ['-c', command]);
    var out = '';
    log.debug('Launching command', command);
    child.stdout.on('data', function(d) {
      out += d.toString();
    });
    child.on('exit', function(code) {
      log.debug('Command result', code);
      if (code == 0) {
        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/plain');
        response.end(out);
      }
      else {
        response.statusCode = 500;
        response.end();
      }
    });
    return;
  }
  if (parsed_url.protocol != 'http:') {
     log.error("Wrong protoocol " + parsed_url.protocol);
    response.statusCode = 500;
    response.end();
    return;
  }
  var directory = "storage/" + parsed_url.host + (parsed_url.pathname || '');
  log.debug("Incoming request " + parsed_url.href);
  if (request.headers['user-agent'] && request.headers['user-agent'].match(/^git/)) {
    process_git_request(response, request.url, directory);
    return;
  }
  if (parsed_url.query) {
    var shasum = crypto.createHash('sha1');
    shasum.update(parsed_url.query);
    var hash = shasum.digest('hex');
    directory += '/' + hash;
  }
  var not_found = argv.no_proxy ? function(response, headers, parsed_url, directory) {
    response.statusCode = 500;
    response.end();
    log.error('File not found on proxy', directory);
  } : proxy;
  if (request.method == 'GET') {
    process_req(response, request.headers, parsed_url, directory, undefined, not_found);
  }
  else {
    var shasum = crypto.createHash('sha1');
    var body_chunks = [];
    request.on('data', function(chunk) {
      shasum.update(chunk);
      body_chunks.push(chunk);
    })
    request.on('end', function() {
      var hash = shasum.digest('hex');
      directory += '/' + hash;
      process_req(response, request.headers, parsed_url, directory, body_chunks, not_found);
    })
  }
}).on('clientError', function(e) {
  console.log(e);
}).on('error', function(err) {
  log.error("HTTP ERROR : " + err);
}).on('connect', function(request, socket, head) {
  var splitted = request.url.split(':');
  log.notice('HTTP CONNECT to', splitted[0], splitted[1]);
  var connection = net.createConnection(splitted[1], splitted[0], function() {
    socket.write('HTTP/1.0 200 Connection established\r\n\r\n');
    socket.pipe(connection);
    connection.pipe(socket);
    socket.on('end', function() {
      log.notice('End HTTP CONNECT to', splitted[0], splitted[1]);
    });
  });
  connection.on('error', function(err) {
    log.notice('HTTP CONNECT error', err);
    socket.write('HTTP/1.0 500 Error\r\n\r\n');
    socket.end();
  })
}).listen(port);

log.notice("Offline Proxy ready on port " + port);

