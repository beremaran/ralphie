class Ralphie < Formula
  desc "Turn a GitHub issue queue into reviewed commits with Pi"
  homepage "https://github.com/beremaran/ralphie"
  version "0.1.0"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/beremaran/ralphie/releases/download/v#{version}/ralphie-darwin-arm64"
    else
      url "https://github.com/beremaran/ralphie/releases/download/v#{version}/ralphie-darwin-x64"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/beremaran/ralphie/releases/download/v#{version}/ralphie-linux-arm64"
    else
      url "https://github.com/beremaran/ralphie/releases/download/v#{version}/ralphie-linux-x64"
    end
  end

  def install
    # The downloaded asset is named ralphie-<os>-<arch>; install it as `ralphie`.
    bin.install Dir["ralphie-*"].first
  end

  test do
    system "#{bin}/ralphie", "--version"
  end
end
