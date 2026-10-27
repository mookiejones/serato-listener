// CoreMIDI reader for the DJM-S11 and the PLX-CRSS12 turntables.
//
// One process prints a JSON line per event. The Node server parses those
// lines. A second CoreMIDI client can subscribe while Serato already has the
// same sources open. This program does not open an audio device.
//
// Lines:
//   {"type":"ports","ports":["DJM-S11","PLX-CRSS12 #1","PLX-CRSS12 #2"]}
//   {"type":"data","port":"DJM-S11","bytes":[176,7,100]}
//
// Arguments are case-insensitive substrings. With no arguments the filters
// are DJM-S11 and PLX-CRSS12. Two sources that share a name are labeled
// "#1" and "#2" in CoreMIDI unique-id order.

import CoreMIDI
import Darwin
import Foundation

private let packetFieldOffset = 4
private let packetLengthOffset = 8
private let packetDataOffset = 10

/// Subscribes to matching MIDI sources and prints their packets.
final class MidiListen: @unchecked Sendable {
  private let lock = NSLock()
  private let output = DispatchQueue(label: "serato-listener.midi-out")
  private let filters: [String]
  private var client = MIDIClientRef()
  private var input = MIDIPortRef()
  private var labels: [Int32: String] = [:]
  private var connected: Set<Int32> = []
  private var lastPorts: [String]?

  init(filters: [String]) {
    self.filters = filters
  }

  /// Creates the client and the input port, then subscribes to current sources.
  ///
  /// Side effects: registers a CoreMIDI client. Notifications refresh the
  /// subscription on the main queue. The caller parks with `dispatchMain`.
  func run() {
    // Swift's imported layout matches the SDK's pack(4) header. Reading a
    // live packet through `pointee` would copy a full 268-byte MIDIPacket and
    // can run past a short packet, so the callback uses these offsets instead.
    precondition(MemoryLayout<MIDIPacketList>.offset(of: \.packet) == packetFieldOffset)
    precondition(MemoryLayout<MIDIPacket>.offset(of: \.length) == packetLengthOffset)
    precondition(MemoryLayout<MIDIPacket>.offset(of: \.data) == packetDataOffset)

    var created = MIDIClientRef()
    let clientStatus = MIDIClientCreateWithBlock("serato-listener" as CFString, &created) { [weak self] notification in
      let id = notification.pointee.messageID
      guard id == .msgSetupChanged || id == .msgObjectAdded || id == .msgObjectRemoved else { return }
      DispatchQueue.main.async {
        self?.refresh()
      }
    }
    guard clientStatus == noErr else {
      fail("midi client failed \(clientStatus)")
    }
    client = created

    var opened = MIDIPortRef()
    let portStatus = MIDIInputPortCreateWithBlock(client, "in" as CFString, &opened) { [weak self] packetList, refCon in
      self?.handle(packetList, refCon: refCon)
    }
    guard portStatus == noErr else {
      fail("midi port failed \(portStatus)")
    }
    input = opened
    refresh()
  }

  /// Reconnects sources whose names match the filters.
  ///
  /// Side effects: connects and disconnects CoreMIDI sources and may print a
  /// `ports` line. Call it on the main queue.
  private func refresh() {
    let found = matchingSources()
    let proposed = labelsFor(found)
    lock.lock()
    labels = proposed
    lock.unlock()

    let foundIds = Set(found.map(\.uid))
    for source in found where !connected.contains(source.uid) {
      let context = UnsafeMutableRawPointer(bitPattern: UInt(UInt32(bitPattern: source.uid)))
      let status = MIDIPortConnectSource(input, source.endpoint, context)
      if status == noErr {
        connected.insert(source.uid)
      } else {
        lock.lock()
        labels.removeValue(forKey: source.uid)
        lock.unlock()
        fputs("midi connect \(source.name) failed \(status)\n", stderr)
      }
    }

    let gone = connected.filter { !foundIds.contains($0) }
    for uid in gone {
      var object = MIDIObjectRef()
      var objectType = MIDIObjectType.other
      if MIDIObjectFindByUniqueID(uid, &object, &objectType) == noErr {
        MIDIPortDisconnectSource(input, object)
      }
      connected.remove(uid)
      lock.lock()
      labels.removeValue(forKey: uid)
      lock.unlock()
    }

    publishPorts()
  }

  /// Copies one packet list to stdout.
  ///
  /// The pointer stays inside the original list. `MIDIPacketNext` advances it.
  /// A copied `MIDIPacket` would drop every packet after the first.
  ///
  /// Side effects: queues one `data` line per packet.
  private func handle(_ list: UnsafePointer<MIDIPacketList>, refCon: UnsafeMutableRawPointer?) {
    guard let refCon else { return }
    let uid = Int32(bitPattern: UInt32(truncatingIfNeeded: UInt(bitPattern: refCon)))
    lock.lock()
    let name = labels[uid] ?? ""
    lock.unlock()
    guard !name.isEmpty else { return }

    let rawList = UnsafeRawPointer(list)
    let count = Int(rawList.load(fromByteOffset: 0, as: UInt32.self))
    guard count > 0 else { return }
    var packet = UnsafeMutablePointer(
      mutating: rawList.advanced(by: packetFieldOffset).assumingMemoryBound(to: MIDIPacket.self)
    )
    for _ in 0..<count {
      let raw = UnsafeRawPointer(packet)
      let length = Int(raw.load(fromByteOffset: packetLengthOffset, as: UInt16.self))
      if length > 0 {
        let bytes = UnsafeBufferPointer(
          start: raw.advanced(by: packetDataOffset).assumingMemoryBound(to: UInt8.self),
          count: length
        )
        writeLine(["type": "data", "port": name, "bytes": bytes.map { Int($0) }])
      }
      packet = MIDIPacketNext(packet)
    }
  }

  /// Prints the connected port names when the set changes.
  ///
  /// Side effects: queues one `ports` line.
  private func publishPorts() {
    let names = connected.sorted { UInt32(bitPattern: $0) < UInt32(bitPattern: $1) }.compactMap { uid in
      lock.lock()
      let name = labels[uid]
      lock.unlock()
      return name
    }
    if let lastPorts, lastPorts == names { return }
    lastPorts = names
    writeLine(["type": "ports", "ports": names])
  }

  /// Lists sources whose display name contains a filter, oldest unique id first.
  ///
  /// Side effects: reads CoreMIDI properties.
  private func matchingSources() -> [MidiSource] {
    var found: [MidiSource] = []
    let count = MIDIGetNumberOfSources()
    for index in 0..<count {
      let endpoint = MIDIGetSource(index)
      if endpoint == 0 { continue }
      guard let name = displayName(endpoint), matches(name) else { continue }
      var uid: Int32 = 0
      guard MIDIObjectGetIntegerProperty(endpoint, kMIDIPropertyUniqueID, &uid) == noErr else { continue }
      found.append(MidiSource(uid: uid, name: name, endpoint: endpoint))
    }
    found.sort { UInt32(bitPattern: $0.uid) < UInt32(bitPattern: $1.uid) }
    return found
  }

  /// Assigns `#1` and `#2` when more than one source has the same name.
  ///
  /// The caller has already sorted `sources` by unique id.
  ///
  /// Side effects: none.
  private func labelsFor(_ sources: [MidiSource]) -> [Int32: String] {
    var totals: [String: Int] = [:]
    for source in sources {
      totals[source.name, default: 0] += 1
    }
    var seen: [String: Int] = [:]
    var labeled: [Int32: String] = [:]
    for source in sources {
      let total = totals[source.name] ?? 1
      if total > 1 {
        let number = (seen[source.name] ?? 0) + 1
        seen[source.name] = number
        labeled[source.uid] = "\(source.name) #\(number)"
      } else {
        labeled[source.uid] = source.name
      }
    }
    return labeled
  }

  /// True when the display name contains one of the command-line filters.
  ///
  /// Side effects: none.
  private func matches(_ name: String) -> Bool {
    let lower = name.lowercased()
    return filters.contains { lower.contains($0) }
  }

  /// Queues one JSON object and a newline.
  ///
  /// The caller copies the port name out of `labels` before this runs, so the
  /// lock is not held across the write.
  ///
  /// Side effects: writes stdout on `output`.
  private func writeLine(_ object: [String: Any]) {
    output.async {
      guard JSONSerialization.isValidJSONObject(object),
            let data = try? JSONSerialization.data(withJSONObject: object),
            let text = String(data: data, encoding: .utf8) else { return }
      print(text)
      fflush(stdout)
    }
  }
}

/// One CoreMIDI source that matched a name filter.
private struct MidiSource {
  let uid: Int32
  let name: String
  let endpoint: MIDIEndpointRef
}

/// Reads the display name, then the object name.
///
/// Side effects: reads a CoreMIDI string property.
private func displayName(_ object: MIDIObjectRef) -> String? {
  stringProperty(object, kMIDIPropertyDisplayName) ?? stringProperty(object, kMIDIPropertyName)
}

/// Reads one string property.
///
/// Side effects: reads a CoreMIDI string property.
private func stringProperty(_ object: MIDIObjectRef, _ property: CFString) -> String? {
  var value: Unmanaged<CFString>?
  guard MIDIObjectGetStringProperty(object, property, &value) == noErr,
        let text = value?.takeRetainedValue() as String?,
        !text.isEmpty else { return nil }
  return text
}

/// Prints an error and stops the helper.
///
/// Side effects: writes stderr and exits with status 1.
private func fail(_ text: String) -> Never {
  fputs("\(text)\n", stderr)
  exit(1)
}

setvbuf(stdout, nil, _IONBF, 0)
let arguments = CommandLine.arguments.dropFirst().map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }.filter { !$0.isEmpty }
let filters = arguments.isEmpty ? ["djm-s11", "plx-crss12"] : Array(arguments)
let listener = MidiListen(filters: filters)
listener.run()
dispatchMain()
