var 
  http = require('http'),
  fs = require('fs'),
  mkdirp = require('mkdirp'),
  util = require('util'),
  nconf = require('nconf');

nconf.argv().defaults({
  'port': 3128,
  'log_level': 2,
});

function log(level, s) {
  if (level <= nconf.get('log_level')) {
    util.log(s);
  }
}

function log_operation() {
  if (2 == nconf.get('log_level')) {
    process.stdout.write('.');
  } 
}

function file_exist(filename, not_exist, exist) {
  fs.stat(filename, function(err, stats) {
    if (err) {
      not_exist(filename);
    }
    else {
      exist(filename, stats);
    }
  });
}

function proxy(response, directory, host, path) {
  log(5, "Create directory " + directory);
  mkdirp(directory, function(err) {
    if (err) {
      log(0, "Unable to create directory " + directory + " : " + err);
      response.statusCode = 500;
      response.end();
      return;
    }
    log(5, "Directory created " + directory);
    log(3, "Start proxy request http://" + host + path);
    http.get({
      host: host,
      port: 80,
      path: path,
    }, function(result) {
      if (result.statusCode == 200) {
        log(3, "Proxy request code 200 http://" + host + path);
        var stream = fs.createWriteStream(directory + "/200.temp", {flags : 'w'});
        stream.on('error', function(e) {
          log(0, "Unable to write file " + directory + "/200.temp : " + e); 
        });
        result.on('data', function(chunk) {
          log(4, "Data received for proxy request http://" + host + path);
          response.write(chunk);
          stream.write(chunk);
        }).on('end', function() {
          log(1, "End of proxy request ok http://" + host + path);
          response.end();
          stream.end();
          fs.rename(directory + "/200.temp", directory + "/200", function(err) {
            if (err) {
              log(0, "Unable to rename file to " + directory + "/200");
            }
            else {
              log_operation();
            }
          });
        }).on('close', function() {
          //HTTP Client never emit this event
        });
        return;
      }
      if (result.statusCode == 404) {
        response.statusCode = 404;
        log(3, "Proxy request 404 http://" + host + path);
        response.end();
        log_operation();
        fs.writeFile(directory + "/404", "", function(err) {
          if (err) {
            log(0, "Unable to write file " + directory + "/200 : " + err); 
          }
        });
        return;
      }
      if (result.statusCode == 302) {
        response.statusCode = 302;
        response.setHeader("Location", result.headers.location);
        log(3, "Proxy request 302 http://" + host + path);
        response.end();
        log_operation();
        fs.writeFile(directory + "/302", result.headers.location, function(err) {
          if (err) {
            log(0, "Unable to write file " + directory + "/302 : " + err); 
          }
        });
        return;
      }
      if (result.statusCode == 301) {
        response.statusCode = 301;
        response.setHeader("Location", result.headers.location);
        log(3, "Proxy request 301 http://" + host + path);
        response.end();
        log_operation();
        fs.writeFile(directory + "/301", result.headers.location, function(err) {
          if (err) {
            log(0, "Unable to write file " + directory + "/301 : " + err); 
          }
        });
        return;
      }
      log(1, "Wrong return code " + result.statusCode + " for proxy request http://" + host + path);
      response.statusCode = 500;
      response.end(result.statusCode);
    }).on('error', function(e) {
      log(1, "Error while proxy request http://" + host + path + " : " + e);
      response.statusCode = 500;
      response.end();
    });
  });
}

function send_redirect(response, code, filename) {
  fs.readFile(filename, function(err, data) {
    if (err) {
      log(1, "Unable to read file " + filename);
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

http.createServer(function (request, response) {
  if (request.method != 'GET') {
    response.statusCode = 405;
    response.end();
    return;
  }
  var result = request.url.match(/^http:\/\/([^\/]+)(\/.*)$/);
  if (! result) {
    log(0, "Unable to parse url " + request.url);
    response.statusCode = 500;
    response.end();
    return; 
  }
  var path = result[2];
  var host = result[1];
  log(3, "Incoming request http://" + host + path);
  var directory = "storage/" + host + path;
  file_exist(directory + "/200", function(filename) {
    file_exist(directory + "/404", function(filename) {
      file_exist(directory + "/302", function(filename) {
        file_exist(directory + "/301", function(filename) {
          proxy(response, directory, host, path);
        },
        function(filename, stats) {
          send_redirect(response, 301, filename);
        });
      },
      function(filename, stats) {
        send_redirect(response, 302, filename);
      });
    },
    function(filename, stats) {
      log(3, "Return 404 for request http://" + host + path);
      response.statusCode = 404;
      response.end();
      log_operation();
    });
  }, function(filename, stats) {
    if (request.headers['if-modified-since']) {
      date = Date.parse(request.headers['if-modified-since']);
      if (date >= stats.mtime) {
        log(3, "Return 304 for request http://" + host + path);
        response.statusCode = 304;
        response.end();
        log_operation();
        return;
      }
    }
    var stream = fs.createReadStream(filename, { flags: 'r', bufferSize: 64 * 1024});
    stream.on('data', function(data) {
      response.write(data);
    }).on('end', function() {
      log(3, "Returned file on disk " + filename);
      response.end();
    }).on('error', function(err) {
      log(0, "Unable to read file " + filename + " : " + err);
      response.statusCode = 500;
      response.end();
    }).on('close', function() {
      log_operation();
      // Nothing to do
    });
  });
}).listen(nconf.get('port'));

log(1, "Offline Proxy ready on port " + nconf.get('port'));

