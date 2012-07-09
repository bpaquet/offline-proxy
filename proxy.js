var
  http = require('http'),
  fs = require('fs'),
  mkdirp = require('mkdirp'),
  util = require('util'),
  nconf = require('nconf'),
  url = require('url');

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

function proxy(response, directory, parsed_url) {
  log(5, "Create directory " + directory);
  mkdirp(directory, function(err) {
    if (err) {
      log(0, "Unable to create directory " + directory + " : " + err);
      response.statusCode = 500;
      response.end();
      return;
    }
    log(5, "Directory created " + directory);
    log(3, "Start proxy request " + parsed_url.href);
    http.get(parsed_url, function(result) {
      if (result.statusCode == 200) {
        log(3, "Proxy request code 200 " + parsed_url.href);
        var stream = fs.createWriteStream(directory + "/200.temp", {flags : 'w'});
        stream.on('error', function(e) {
          log(0, "Unable to write file " + directory + "/200.temp : " + e); 
        });
        result.on('data', function(chunk) {
          log(4, "Data received for proxy request " + parsed_url.href);
          response.write(chunk);
          stream.write(chunk);
        }).on('end', function() {
          log(1, "End of proxy request ok " + parsed_url.href);
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
        log(3, "Proxy request 404 " + parsed_url.href);
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
        log(3, "Proxy request 302 " + parsed_url.href);
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
        log(3, "Proxy request 301 " + parsed_url.href);
        response.end();
        log_operation();
        fs.writeFile(directory + "/301", result.headers.location, function(err) {
          if (err) {
            log(0, "Unable to write file " + directory + "/301 : " + err);
          }
        });
        return;
      }
      log(1, "Wrong return code " + result.statusCode + " for proxy request  " + parsed_url.href);
      response.statusCode = 500;
      response.end();
    }).on('error', function(e) {
      log(1, "Error while proxy request " + parsed_url.href + " : " + e);
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
  var parsed_url = url.parse(request.url);
  if (! parsed_url) {
    log(0, "Unable to parse url " + request.url);
    response.statusCode = 500;
    response.end();
    return;
  }
  log(3, "Incoming request " + parsed_url.href);
  var directory = "storage/" + parsed_url.host + parsed_url.path;
  file_exist(directory + "200", function(filename) {
    file_exist(directory + "404", function(filename) {
      file_exist(directory + "302", function(filename) {
        file_exist(directory + "301", function(filename) {
          proxy(response, directory, parsed_url);
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
      log(3, "Return 404 for request " + parsed_url.href);
      response.statusCode = 404;
      response.end();
      log_operation();
    });
  }, function(filename, stats) {
    if (request.headers['if-modified-since']) {
      date = Date.parse(request.headers['if-modified-since']);
      if (date >= stats.mtime) {
        log(3, "Return 304 for request " + parsed_url.href);
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
}).listen(nconf.get('port')).on('clientError', function(e) {
  console.log(e);
}).on('error', function(err) {
  log(0, "HTTP ERROR : " + err);
});

log(1, "Offline Proxy ready on port " + nconf.get('port'));

