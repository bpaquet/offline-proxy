require 'rubygems'
require 'net/http'
require 'date'
require 'rack'

class Date
  def to_gm_time
    to_time(new_offset, :gm)
  end

  def to_local_time
    to_time(new_offset(DateTime.now.offset-offset), :local)
  end

  private
  def to_time(dest, method)
    #Convert a fraction of a day to a number of microseconds
    usec = (dest.sec_fraction * 60 * 60 * 24 * (10**6)).to_i
    Time.send(method, dest.year, dest.month, dest.day, dest.hour, dest.min,
              dest.sec, usec)
  end
end

class Proxy

  def call(env)
    if env["PATH_INFO"]
      host = env["HTTP_HOST"]
      path = env["PATH_INFO"]
    else
      request_uri = env["REQUEST_URI"]
      raise "Unable to parse uri #{request_uri}" unless request_uri =~ /^http:\/\/([^\/]+)(\/.*)$/
      host, path = $1, $2
    end
    path += "?#{env["QUERY_STRING"]}" if env["QUERY_STRING"] && !env["QUERY_STRING"].empty?
    target = File.join(File.dirname(__FILE__), "storage", "200", host, path)
    if File.exists? target
      if env["HTTP_IF_MODIFIED_SINCE"]
        if_modified_since = DateTime.parse(env["HTTP_IF_MODIFIED_SINCE"]).to_local_time
        modified = File.stat(target).mtime
        if if_modified_since > modified
          return [304, {}, ""]
        end
      end
      return [200, {"Content-Type" => "application/octet-stream"}, File.read(target)]
    end
    target_special = File.join(File.dirname(__FILE__), "storage", "special", host, path)
    f = File.join(target_special, "301")
    if File.exists? f
      return [301, {"Location" => File.read(f), "Content-Type" => "application/octet-stream"}, ""]
    end
    f = File.join(target_special, "302")
    if File.exists? f
      return [302, {"Location" => File.read(f), "Content-Type" => "application/octet-stream"}, ""]
    end
    f = File.join(target_special, "404")
    if File.exists? f
      return [404, {"Content-Type" => "application/octet-stream"}, ""]
    end
    puts "HTTP Call #{host} #{path}"
    result = Net::HTTP.get_response(host, path)
    if result.code == "200"
      FileUtils.mkdir_p File.dirname(target)
      File.open(target, "wb") {|io| io.write result.body}
      return [200, {"Content-Type" => "application/octet-stream"}, File.read(target)]
    elsif result.code == "404"
      FileUtils.mkdir_p target_special
      File.open(File.join(target_special, result.code), "wb") {|io| io.write ""}
      return [404, {"Content-Type" => "application/octet-stream"}, ""]
    elsif result.code == "301" || result.code == "302"
      FileUtils.mkdir_p target_special
      File.open(File.join(target_special, result.code), "wb") {|io| io.write result["Location"]}
      return [result.code.to_i, {"Location" => result["Location"], "Content-Type" => "application/octet-stream"}, ""]
    else
      raise "error #{host} #{path} #{result.code}"
    end
  end

end