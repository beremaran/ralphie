class Ralphie < Formula
  desc "Turn a GitHub issue queue into reviewed commits with Pi"
  homepage "https://github.com/beremaran/ralphie"
  license "MIT"
  version "0.1.0"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/beremaran/ralphie/releases/download/v#{version}/ralphie-darwin-arm64"
      sha256 "cf08e4f99392f08d712a02a02eef743078ff9c5ca8be802b66895dcfd72167aa"
    else
      url "https://github.com/beremaran/ralphie/releases/download/v#{version}/ralphie-darwin-x64"
      sha256 "fa0b3928ef2aa24847e200ca27153e0965f36a932e3aa1eb2326319264c149ae"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/beremaran/ralphie/releases/download/v#{version}/ralphie-linux-arm64"
      sha256 "6bdfae15d4c09f7e1d69e31169165a30feedc5d83683e2b14d20ee972b4b9f8f"
    else
      url "https://github.com/beremaran/ralphie/releases/download/v#{version}/ralphie-linux-x64"
      sha256 "46be1e5f11dc83f89374c834f24cf8f83e4f66e8e44965f9367145caef3ddf2b"
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
