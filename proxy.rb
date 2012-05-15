require 'bundler/setup'
require 'sinatra'
require 'net/http'

class Proxy < Sinatra::Base

  get '/*/*' do
    host = params[:splat][0]
    path = "/" + params[:splat][1]
    path += "?#{request.query_string}" if request.query_string && !request.query_string.empty?
    target = File.join(File.dirname(__FILE__), "storage", "200", host, path)
    if File.exists? target
      content_type 'application/octet-stream'
      response.write File.read(target)
      return 200
    end
    target_redirect = File.join(File.dirname(__FILE__), "storage", "redirect", host, path)
    f = File.join(target_redirect, "301")
    if File.exists? f
      response["Location"] = File.read f
      return 301
    end
    f = File.join(target_redirect, "302")
    if File.exists? f
      response["Location"] = File.read f
      return 302
    end
    puts "HTTP Call #{host} #{path}"
    result = Net::HTTP.get_response(host, path)
    if result.code == "200"
      FileUtils.mkdir_p File.dirname(target)
      File.open(target, "wb") {|io| io.write result.body}
      content_type 'application/octet-stream'
      response.write result.body
      return 200
    elsif result.code == "404"
      target_404 = File.join(File.dirname(__FILE__), "storage", "404", host, path)
      FileUtils.mkdir_p File.dirname(target_404)
      File.open(target_404, "wb") {|io| io.write ""}
      return 404
    elsif result.code == "301" || result.code == "302"
      FileUtils.mkdir_p target_redirect
      File.open(File.join(target_redirect, result.code), "wb") {|io| io.write result["Location"]}
      response["Location"] = result["Location"]
      return result.code.to_i
    else
      raise "error #{host} #{path} #{result.code}"
    end
  end

end