require 'bundler/setup'
require 'sinatra'
require 'net/http'

class Proxy < Sinatra::Base

  get '/*/*' do
    host = params[:splat][0]
    path = "/" + params[:splat][1]
    puts "HTTP Call #{host} #{path}"
    result = Net::HTTP.get_response(host, path)
    if result.code == "200"
      target = File.join(File.dirname(__FILE__), "storage", "200", host, path)
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
      target_redirect = File.join(File.dirname(__FILE__), "storage", "redirect", host, path, result.code)
      FileUtils.mkdir_p File.dirname(target_redirect)
      File.open(target_redirect, "wb") {|io| io.write response["Location"]}
      response["Location"] = result["Location"]
      return result.code.to_i
    else
      raise "error #{host} #{path} #{result.code}"
    end
  end

end