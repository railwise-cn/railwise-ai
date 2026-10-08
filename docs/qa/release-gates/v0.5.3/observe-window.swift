#!/usr/bin/env swift

import CoreGraphics
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

guard CommandLine.arguments.count == 2,
      let targetPID = Int32(CommandLine.arguments[1]),
      targetPID > 0 else {
    fail("Usage: swift observe-window.swift POSITIVE_EXACT_PID")
}

func boundsJSON(_ bounds: CGRect) -> [String: Double] {
    ["x": Double(bounds.origin.x), "y": Double(bounds.origin.y),
     "width": Double(bounds.width), "height": Double(bounds.height)]
}

var displayCount: UInt32 = 0
guard CGGetActiveDisplayList(0, nil, &displayCount) == .success else {
    fail("Cannot read active display inventory")
}
var displayIDs = [CGDirectDisplayID](repeating: 0, count: Int(displayCount))
var actualDisplayCount: UInt32 = 0
let displayError = displayIDs.withUnsafeMutableBufferPointer {
    CGGetActiveDisplayList(displayCount, $0.baseAddress, &actualDisplayCount)
}
guard displayError == .success else { fail("Cannot read active display IDs") }
displayIDs = Array(displayIDs.prefix(Int(actualDisplayCount)))

let displays: [[String: Any]] = displayIDs.map { displayID in
    let bounds = CGDisplayBounds(displayID)
    var result: [String: Any] = [
        "id": displayID,
        "bounds": boundsJSON(bounds),
        "isMain": CGDisplayIsMain(displayID) != 0
    ]
    if let mode = CGDisplayCopyDisplayMode(displayID), mode.width > 0, mode.height > 0 {
        result["modeSize"] = ["width": mode.width, "height": mode.height]
        result["pixelSize"] = ["width": mode.pixelWidth, "height": mode.pixelHeight]
        result["scaleX"] = Double(mode.pixelWidth) / Double(mode.width)
        result["scaleY"] = Double(mode.pixelHeight) / Double(mode.height)
    }
    return result
}

// CoreGraphics is observed only; no accessibility or UI action API is used.
let options: CGWindowListOption = [.optionAll, .excludeDesktopElements]
guard let inventory = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
    fail("Cannot read window inventory")
}
let targetWindows = inventory.filter {
    ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == targetPID
}
guard !targetWindows.isEmpty else { fail("No windows found for PID \(targetPID)") }

let windows: [[String: Any]] = targetWindows.map { entry in
    let title = entry[kCGWindowName as String] as? String
    var result: [String: Any] = [
        "id": entry[kCGWindowNumber as String] ?? NSNull(),
        "ownerPID": targetPID,
        "ownerName": entry[kCGWindowOwnerName as String] ?? NSNull(),
        "title": title.map { $0 as Any } ?? NSNull(),
        "titleAvailable": title != nil,
        "layer": entry[kCGWindowLayer as String] ?? NSNull(),
        "onScreen": entry[kCGWindowIsOnscreen as String] ?? false,
        "alpha": entry[kCGWindowAlpha as String] ?? NSNull()
    ]
    if let dictionary = entry[kCGWindowBounds as String] as? [String: Any],
       let bounds = CGRect(dictionaryRepresentation: dictionary as CFDictionary) {
        result["bounds"] = boundsJSON(bounds)
        result["displayIDs"] = displayIDs.filter { bounds.intersects(CGDisplayBounds($0)) }
    } else {
        result["bounds"] = NSNull()
        result["displayIDs"] = [] as [UInt32]
    }
    return result
}

var output: [String: Any] = [
    "schemaVersion": 1,
    "operation": "observe-window",
    "capturedAt": ISO8601DateFormatter().string(from: Date()),
    "targetPID": targetPID,
    "coordinateSystem": "CoreGraphics global display coordinates",
    "displays": displays,
    "windows": windows
]
if #available(macOS 10.15, *) {
    output["screenCapturePermissionGranted"] = CGPreflightScreenCaptureAccess()
}

do {
    let data = try JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted, .sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
    fail("Cannot serialize observed window data: \(error)")
}
