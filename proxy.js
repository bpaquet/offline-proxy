var
  http = require('http'),
  fs = require('fs'),
  mkdirp = require('mkdirp'),
  util = require('util'),
  log = require('log4node'),
  url = require('url'),
  net = require('net'),
  crypto = require('crypto');

var argv = require('optimist').argv;

var port = argv.port || 3128;

log.setLogLevel('notice');

if (argv.log_level) {
  log.setLogLevel(argv.log_level);
}

function log_operation() {
  process.stdout.write('.');
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
  302: function(result, directory, response, call_process_req) {
    fs.writeFile(directory + "/302", result.headers.location, function(err) {
      if (err) {
        return log.error("Unable to write file " + directory + "/302 : " + err);
      }
      call_process_req();
    });
  },
  302: function(result, directory, response, call_process_req) {
    fs.writeFile(directory + "/301", result.headers.location, function(err) {
      if (err) {
        return log.error("Unable to write file " + directory + "/301 : " + err);
      }
      call_process_req();
    });
  },
  404: function(result, directory, response, call_process_req) {
    fs.writeFile(directory + "/404", "", function(err) {
      if (err) {
        return log.error("Unable to write file " + directory + "/404 : " + err);
      }
      call_process_req();
    });
  },
  200: function(result, directory, response, call_process_req) {
    log.info("Proxy request code 200 " + directory);
    fs.writeFile(directory + "/200.headers", JSON.stringify(result.headers), function(err) {
      if (err) {
        return log.error("Unable to write headers file " + directory + "/200.headers: " + err);
      }
    });
    copyHeadersIfExists(headers_to_copy_from_disk, result.headers, function(k, v) {response.setHeader(k, v)});
    var stream = fs.createWriteStream(directory + "/200.temp", {flags : 'w'});
    stream.on('error', function(err) {
      log.error("Unable to write file " + directory + "/200.temp: " + err);
    });
    result.pipe(response);
    result.pipe(stream);
    result.on('end', function() {
      log.notice("End of proxy request ok " + directory);
      setTimeout(function() {
        fs.rename(directory + "/200.temp", directory + "/200", function(err) {
          if (err) {
            return log.error("Unable to rename file to " + directory + "/200: " + err);
          }
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

function proxy(response, headers, parsed_url, directory, body_chunks) {
  log.debug("Create directory " + directory);
  mkdirp(directory, function(err) {
    if (err) {
      log.error("Unable to create directory " + directory + " : " + err);
      response.statusCode = 500;
      response.end();
      return;
    }
    log.debug("Directory created " + directory);
    log.info("Start proxy request " + directory);
    if (body_chunks) {
      parsed_url.method = 'POST';
      parsed_url.headers = {};
      copyHeadersIfExists([
        'Content-Type',
        'Accept',
        'User-Agent',
        'Content-Encoding',
        'Accept-Encoding',
        'Content-length',
        ], headers, function(k, v) {parsed_url.headers[k] = v;});
    }
    var proxy_req = http.request(parsed_url, function(result) {
      var f = proxy_map[result.statusCode];
      if (!f) {
        log.notice("Wrong return code " + result.statusCode + " for proxy request  " + directory);
        response.statusCode = 500;
        response.end();
        return;
      }
      f(result, directory, response, function() {
        process_req(response, headers, parsed_url, directory, body_chunks, function() {
          log.error('Internal error, no file found after proxy request for', directory);
        })
      });
    });
    proxy_req.on('error', function(e) {
      log.error("Error while proxy request " + directory + " : " + e);
      response.statusCode = 500;
      response.end();
    });
    if (body_chunks) {
      body_chunks.forEach(function(chunk) {
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
            log.info("Return 304 for request " + filename);
            response.statusCode = 304;
            response.end();
            log_operation();
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
    return  not_found(response, headers, parsed_url, directory, body_chunks);
  }
  var code = l.shift();
  log.debug('Searching', code, 'for', directory);
  file_exist(directory + '/' + code, function(filename, stats) {
    process_map[code](response, headers, filename, stats);
  }, function(filename) {
    process_req_internal(l, response, headers, parsed_url, directory, body_chunks, not_found);
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
  if (parsed_url.protocol != 'http:') {
     log.error("Wrong protoocol " + parsed_url.protocol);
    response.statusCode = 500;
    response.end();
    return;
  }
  log.debug("Incoming request " + parsed_url.href);
  var directory = "storage/" + parsed_url.host + parsed_url.pathname;
  if (parsed_url.query) {
    var shasum = crypto.createHash('sha1');
    shasum.update(parsed_url.query);
    var hash = shasum.digest('hex');
    directory += '/' + hash;
  }
  if (request.method == 'GET') {
    process_req(response, request.headers, parsed_url, directory, undefined, proxy);
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
      process_req(response, request.headers, parsed_url, directory, body_chunks, proxy);
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

