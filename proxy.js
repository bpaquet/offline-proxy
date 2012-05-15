var http = require('http');
var fs = require('fs');
var mkdirp = require('mkdirp');
var port = 3128;

var log_level = 1;

function log(level, s) {
  if (level <= log_level) {
    console.log(s);
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
    log(2, "Start proxy request http://" + host + path);
    http.get({
      host: host,
      port: 80,
      path: path,
    }, function(result) {
      if (result.statusCode == 200) {
        log(2, "Proxy request code 200 http://" + host + path);
        var stream = fs.createWriteStream(directory + "/200", {flags : 'w'});
        stream.on('error', function(e) {
          log(0, "Unable to write file " + directory + "/200 : " + e); 
        });
        result.on('data', function(chunk) {
          log(3, "Data received for proxy request http://" + host + path);
          response.write(chunk);
          stream.write(chunk);
        }).on('end', function() {
          log(1, "End of proxy request ok http://" + host + path);
          response.end();
          stream.end();
        }).on('close', function() {
          log(1, "Close for proxy request http://" + host + path);
          response.statusCode = 500;
          response.end();  
          stream.end();
        });
        return;
      }
      if (result.statusCode == 404) {
        response.statusCode = 404;
        log(2, "Proxy request 404 http://" + host + path);
        response.end();
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
        log(1, "Proxy request 302 http://" + host + path);
        response.end();
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
        log(1, "Proxy request 301 http://" + host + path);
        response.end();
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
      log(3, "Error while proxy request http://" + host + path + " : " + e);
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
  });
}

http.createServer(function (request, response) {
  var result = request.url.match(/^http:\/\/([^\/]+)(\/.*)$/);
  var path = result[2];
  var host = result[1];
  log(2, "Incoming request http://" + host + path);
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
      log(2, "Return 404 for request http://" + host + path);
      response.statusCode = 404;
      response.end();
    });
  }, function(filename, stats) {
    if (request.headers['if-modified-since']) {
      date = Date.parse(request.headers['if-modified-since']);
      if (date >= stats.mtime) {
        log(2, "Return 304 for request http://" + host + path);
        response.statusCode = 304;
        response.end();
        return;
      }
    }
    log(2, "Return file on disk " + filename);
    fs.readFile(filename, function(err, data) {
      if (err) {
        log(1, "Unable to read file " + filename);
        response.statusCode = 500;
        response.end();
        return;
      }
      response.statusCode = 200;
      response.end(data);
    });
  });
}).listen(port);

log(1, "Offline Proxy ready on port " + port);

