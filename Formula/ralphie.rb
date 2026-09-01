class Ralphie < Formula
  desc "Turn a GitHub issue queue into reviewed commits with Pi"
  homepage "https://github.com/beremaran/ralphie"
  license "MIT"
  # BEGIN RALPHIE GENERATED RELEASE METADATA
  version "0.1.2"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/beremaran/ralphie/releases/download/v#{version}/ralphie-darwin-arm64"
      sha256 "30be72de92306adb5609a6e8bc2ddb9e9cc29d671e8e0dd87c1921f11aaaf5c5"
    else
      url "https://github.com/beremaran/ralphie/releases/download/v#{version}/ralphie-darwin-x64"
      sha256 "c08317b2f19011970d7a1579422d9c634cb756eaefafb147704ef8bbf1605ac8"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/beremaran/ralphie/releases/download/v#{version}/ralphie-linux-arm64"
      sha256 "c23f670a69c60c8770bb4958e91ae3007804bab889b55ee8807f2fffd04295f5"
    else
      url "https://github.com/beremaran/ralphie/releases/download/v#{version}/ralphie-linux-x64"
      sha256 "c0d8b5ff1b24e554121bf879fb68380038ca7fbe27a63fd5857d6a1b27d2b300"
    end
  end
  # END RALPHIE GENERATED RELEASE METADATA

  def install
    # The downloaded asset is named ralphie-<os>-<arch>; install it as `ralphie`.
    bin.install Dir["ralphie-*"].first => "ralphie"
  end

  test do
    system "#{bin}/ralphie", "--version"
  end
end
