import Foundation
import CoreGraphics

#if os(macOS)
import AppKit
typealias PlatformImage = NSImage
#elseif canImport(UIKit)
import UIKit
typealias PlatformImage = UIImage
#endif

extension PlatformImage {
    func pngDataCompatible() -> Data? {
#if os(macOS)
        guard let tiff = tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff) else { return nil }
        return rep.representation(using: .png, properties: [:])
#else
        return pngData()
#endif
    }

    func cropped(to rectInPoints: CGRect, fromViewSize viewSize: CGSize) -> PlatformImage? {
#if os(macOS)
        guard let cgImage = self.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            return nil
        }
#else
        guard let cgImage = self.cgImage else { return nil }
#endif

        let scaleX = CGFloat(cgImage.width) / max(viewSize.width, 1)
        let scaleY = CGFloat(cgImage.height) / max(viewSize.height, 1)

        var crop = CGRect(
            x: rectInPoints.minX * scaleX,
            y: rectInPoints.minY * scaleY,
            width: rectInPoints.width * scaleX,
            height: rectInPoints.height * scaleY
        ).integral

        crop = crop.intersection(CGRect(x: 0, y: 0, width: cgImage.width, height: cgImage.height))
        guard crop.width >= 2, crop.height >= 2,
              let cropped = cgImage.cropping(to: crop) else { return nil }

#if os(macOS)
        return NSImage(cgImage: cropped, size: NSSize(width: crop.width, height: crop.height))
#else
        return UIImage(cgImage: cropped)
#endif
    }

    static func fromBGRA(
        bgraData: Data,
        width: Int,
        height: Int,
        bytesPerRow: Int
    ) -> PlatformImage? {
        // Metal drawable / render-target blit: row 0 is the top of the image (unlike WebGL).
        // Do not vertically flip — that was mapping selection boxes to the wrong region.
        var rgba = [UInt8](repeating: 0, count: width * height * 4)
        bgraData.withUnsafeBytes { raw in
            guard let src = raw.bindMemory(to: UInt8.self).baseAddress else { return }
            for y in 0..<height {
                for x in 0..<width {
                    let srcIndex = y * bytesPerRow + x * 4
                    let dstIndex = (y * width + x) * 4
                    rgba[dstIndex + 0] = src[srcIndex + 2]
                    rgba[dstIndex + 1] = src[srcIndex + 1]
                    rgba[dstIndex + 2] = src[srcIndex + 0]
                    rgba[dstIndex + 3] = src[srcIndex + 3]
                }
            }
        }

        let packedBytesPerRow = width * 4
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: &rgba,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: packedBytesPerRow,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ),
        let cgImage = context.makeImage() else {
            return nil
        }

#if os(macOS)
        return NSImage(cgImage: cgImage, size: NSSize(width: width, height: height))
#else
        return UIImage(cgImage: cgImage)
#endif
    }
}
