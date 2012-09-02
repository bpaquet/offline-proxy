var
  http = require('http'),
  fs = require('fs'),
  mkdirp = require('mkdirp'),
  util = require('util'),
  log = require('log4node'),
  url = require('url'),
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

function proxy(response, directory, parsed_url, body, headers) {
  log.debug("Create directory " + directory);
  mkdirp(directory, function(err) {
    if (err) {
      log.error("Unable to create directory " + directory + " : " + err);
      response.statusCode = 500;
      response.end();
      return;
    }
    log.debug("Directory created " + directory);
    log.info("Start proxy request " + parsed_url.href);
    if (body) {
      parsed_url.method = 'POST';
      parsed_url.headers = {};
      parsed_url.headers['Content-Type'] = headers['content-type'];
      parsed_url.headers['Accept'] = headers['accept'];
      parsed_url.headers['Content-length'] = body.length;
    }
    console.log(parsed_url, body);
    http.request(parsed_url, function(result) {
      if (result.statusCode == 200) {
        log.info("Proxy request code 200 " + parsed_url.href);
        var stream = fs.createWriteStream(directory + "/200.temp", {flags : 'w'});
        stream.on('error', function(e) {
          log.error("Unable to write file " + directory + "/200.temp : " + e);
        });
        result.on('data', function(chunk) {
          log.debug("Data received for proxy request " + parsed_url.href);
          response.write(chunk);
          stream.write(chunk);
        }).on('end', function() {
          log.notice("End of proxy request ok " + parsed_url.href);
          response.end();
          stream.end();
          fs.rename(directory + "/200.temp", directory + "/200", function(err) {
            if (err) {
              log.error("Unable to rename file to " + directory + "/200");
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
        log.info("Proxy request 404 " + parsed_url.href);
        response.end();
        log_operation();
        fs.writeFile(directory + "/404", "", function(err) {
          if (err) {
            log.error("Unable to write file " + directory + "/200 : " + err);
          }
        });
        return;
      }
      if (result.statusCode == 302) {
        response.statusCode = 302;
        response.setHeader("Location", result.headers.location);
        log.info("Proxy request 302 " + parsed_url.href);
        response.end();
        log_operation();
        fs.writeFile(directory + "/302", result.headers.location, function(err) {
          if (err) {
            log.error("Unable to write file " + directory + "/302 : " + err);
          }
        });
        return;
      }
      if (result.statusCode == 301) {
        response.statusCode = 301;
        response.setHeader("Location", result.headers.location);
        log.info("Proxy request 301 " + parsed_url.href);
        response.end();
        log_operation();
        fs.writeFile(directory + "/301", result.headers.location, function(err) {
          if (err) {
            log.error("Unable to write file " + directory + "/301 : " + err);
          }
        });
        return;
      }
      log.notice("Wrong return code " + result.statusCode + " for proxy request  " + parsed_url.href);
      response.statusCode = 500;
      response.end();
    }).on('error', function(e) {
      log.error("Error while proxy request " + parsed_url.href + " : " + e);
      response.statusCode = 500;
      response.end();
    }).end(body);
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

function process_req(request, response, parsed_url, directory, body) {
  file_exist(directory + "/200", function(filename) {
    file_exist(directory + "/404", function(filename) {
      file_exist(directory + "/302", function(filename) {
        file_exist(directory + "/301", function(filename) {
          proxy(response, directory, parsed_url, body, request.headers);
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
      log.info("Return 404 for request " + parsed_url.href);
      response.statusCode = 404;
      response.end();
      log_operation();
    });
  }, function(filename, stats) {
    if (request.headers['if-modified-since']) {
      date = Date.parse(request.headers['if-modified-since']);
      if (date >= stats.mtime) {
        log.info("Return 304 for request " + parsed_url.href);
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
      log.info("Returned file on disk " + filename);
      response.end();
    }).on('error', function(err) {
      log.error("Unable to read file " + filename + " : " + err);
      response.statusCode = 500;
      response.end();
    }).on('close', function() {
      log_operation();
      // Nothing to do
    });
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
  log.debug("Incoming request " + parsed_url.href);
  var directory = "storage/" + parsed_url.host + parsed_url.path;
  if (request.method == 'GET') {
    process_req(request, response, parsed_url, directory);
  }
  else {
    var shasum = crypto.createHash('sha1');
    var body = "";
    request.on('data', function(chunk) {
      shasum.update(chunk);
      body += chunk;
    })
    request.on('end', function() {
      var hash = shasum.digest('hex');
      directory += '/' + hash;
      process_req(request, response, parsed_url, directory, body);
    })
  }
}).listen(port).on('clientError', function(e) {
  console.log(e);
}).on('error', function(err) {
  log.error("HTTP ERROR : " + err);
});

log.notice("Offline Proxy ready on port " + port);

