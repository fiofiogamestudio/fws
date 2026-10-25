param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$Root,
    [switch]$Progress,
    [switch]$FileDetails
)

# Windows PowerShell 5.1+: read metadata only. JSON goes to stdout; optional
# progress goes to stderr. The caller owns any redirection or evidence file.
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This scanner requires Windows; use scan-space.mjs on other systems.'
}
if ($Root -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))' -or $Root -match '^\\\\[?.][\\/]') {
    throw 'Root must be an explicit absolute drive or UNC directory path.'
}
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;

public sealed class FwNativeSpaceScanner {
    private sealed class Row {
        public string RelativePath;
        public long Bytes, DirectBytes, Files, DirectFiles, Directories = 1, ChildDirectories;
        public long Errors, DirectErrors, Skipped, DirectSkipped;
        public DateTime? Earliest, Latest;
        public readonly List<string> GitMarkers = new List<string>();
        public List<string> FileEntries;
    }

    private readonly string root, prefix;
    private readonly TextWriter output, progress;
    private readonly bool fileDetails;
    private readonly Stopwatch clock = Stopwatch.StartNew();
    private readonly List<string> errors = new List<string>(), skipped = new List<string>();
    private long files, bytes, directories, errorCount, skippedCount, lastProgress = -5000;
    private bool firstRow = true;

    private FwNativeSpaceScanner(string rootPath, TextWriter stdout, TextWriter stderr, bool includeFileDetails) {
        root = rootPath;
        prefix = root.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal) ? root : root + Path.DirectorySeparatorChar;
        output = stdout;
        progress = stderr;
        fileDetails = includeFileDetails;
    }

    private static string Quote(string value) {
        if (value == null) return "null";
        StringBuilder text = new StringBuilder("\"");
        foreach (char c in value) {
            switch (c) {
                case '\\': text.Append("\\\\"); break;
                case '"': text.Append("\\\""); break;
                case '\r': text.Append("\\r"); break;
                case '\n': text.Append("\\n"); break;
                case '\t': text.Append("\\t"); break;
                default:
                    if (c < 32) text.Append("\\u" + ((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else text.Append(c);
                    break;
            }
        }
        return text.Append('"').ToString();
    }

    private static string Time(DateTime? value) {
        return value.HasValue ? Quote(value.Value.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture)) : "null";
    }

    private static string RowJson(Row row) {
        string parent = row.RelativePath == "." ? null : row.RelativePath.Contains("/") ? row.RelativePath.Substring(0, row.RelativePath.LastIndexOf('/')) : ".";
        List<string> markers = new List<string>();
        foreach (string name in row.GitMarkers) markers.Add(Quote(name));
        return "{\"relativePath\":" + Quote(row.RelativePath) + ",\"parentRelativePath\":" + Quote(parent)
            + ",\"logicalBytes\":" + row.Bytes + ",\"directBytes\":" + row.DirectBytes
            + ",\"files\":" + row.Files + ",\"directFiles\":" + row.DirectFiles
            + ",\"directories\":" + row.Directories + ",\"childDirectories\":" + row.ChildDirectories
            + ",\"errorCount\":" + row.Errors + ",\"directErrorCount\":" + row.DirectErrors
            + ",\"skippedCount\":" + row.Skipped + ",\"directSkippedCount\":" + row.DirectSkipped
            + ",\"earliestFileMtime\":" + Time(row.Earliest) + ",\"latestFileMtime\":" + Time(row.Latest)
            + ",\"directGitMarkers\":[" + String.Join(",", markers.ToArray()) + "]"
            + ",\"directFileEntries\":" + (row.FileEntries == null ? "null" : "[" + String.Join(",", row.FileEntries.ToArray()) + "]") + "}";
    }

    private void Notify(string currentPath, bool final) {
        if (progress == null || (!final && clock.ElapsedMilliseconds - lastProgress < 5000)) return;
        lastProgress = clock.ElapsedMilliseconds;
        output.Flush();
        progress.WriteLine("{\"files\":" + files + ",\"directories\":" + directories + ",\"logicalBytes\":" + bytes
            + ",\"elapsedMs\":" + clock.ElapsedMilliseconds + ",\"errorCount\":" + errorCount + ",\"skippedCount\":" + skippedCount
            + ",\"currentPath\":" + Quote(currentPath) + ",\"final\":" + (final ? "true" : "false") + "}");
        progress.Flush();
    }

    private void Error(string filename, Exception error, Row row) {
        errorCount++; row.Errors++; row.DirectErrors++;
        if (errors.Count < 100) errors.Add("{\"path\":" + Quote(filename) + ",\"code\":" + Quote(error.GetType().Name) + ",\"message\":" + Quote(error.Message) + "}");
    }

    private void Skip(string filename, string reason, Row row) {
        skippedCount++; row.Skipped++; row.DirectSkipped++;
        if (skipped.Count < 100) skipped.Add("{\"path\":" + Quote(filename) + ",\"reason\":" + Quote(reason) + "}");
    }

    private void Emit(Row row) {
        if (!firstRow) output.Write(',');
        firstRow = false;
        output.Write(RowJson(row));
    }

    private static void Merge(Row parent, Row child) {
        parent.Bytes += child.Bytes; parent.Files += child.Files; parent.Directories += child.Directories;
        parent.Errors += child.Errors; parent.Skipped += child.Skipped;
        if (child.Earliest.HasValue && (!parent.Earliest.HasValue || child.Earliest < parent.Earliest)) parent.Earliest = child.Earliest;
        if (child.Latest.HasValue && (!parent.Latest.HasValue || child.Latest > parent.Latest)) parent.Latest = child.Latest;
    }

    private static void MarkGit(Row row, FileSystemInfo[] entries) {
        Dictionary<string, string> names = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (FileSystemInfo entry in entries) names[entry.Name] = entry.Name;
        if (names.ContainsKey(".git")) row.GitMarkers.Add(names[".git"]);
        foreach (string[] group in new string[][] { new string[] { "HEAD", "objects", "refs" }, new string[] { "HEAD", "commondir", "gitdir" } }) {
            bool present = true;
            foreach (string name in group) if (!names.ContainsKey(name)) present = false;
            if (present) foreach (string name in group) if (!row.GitMarkers.Contains(names[name])) row.GitMarkers.Add(names[name]);
        }
    }

    private Row Visit(DirectoryInfo directory) {
        Row row = new Row();
        if (fileDetails) row.FileEntries = new List<string>();
        row.RelativePath = String.Equals(directory.FullName, root, StringComparison.OrdinalIgnoreCase) ? "." : directory.FullName.Substring(prefix.Length).Replace('\\', '/');
        directories++;
        Notify(directory.FullName, false);
        FileSystemInfo[] entries;
        try {
            // Materialize native enumeration metadata once. Repeated stat calls
            // for each file make large Windows projects unnecessarily slow.
            entries = directory.GetFileSystemInfos();
        } catch (Exception error) {
            Error(directory.FullName, error, row);
            Emit(row);
            return row;
        }
        MarkGit(row, entries);
        foreach (FileSystemInfo entry in entries) {
            FileAttributes attributes;
            try { attributes = entry.Attributes; }
            catch (Exception error) { Error(entry.FullName, error, row); continue; }
            if ((attributes & FileAttributes.ReparsePoint) != 0) {
                Skip(entry.FullName, "native-reparse-point", row);
            } else if (entry is DirectoryInfo) {
                Row child = Visit((DirectoryInfo)entry);
                row.ChildDirectories++;
                Merge(row, child);
            } else if (entry is FileInfo && (attributes & FileAttributes.Device) == 0) {
                long length;
                DateTime modified;
                try { length = ((FileInfo)entry).Length; modified = entry.LastWriteTimeUtc; }
                catch (Exception error) { Error(entry.FullName, error, row); continue; }
                row.Bytes += length; row.DirectBytes += length; row.Files++; row.DirectFiles++;
                files++; bytes += length;
                if (fileDetails) row.FileEntries.Add("{\"name\":" + Quote(entry.Name) + ",\"logicalBytes\":" + length + ",\"modifiedAt\":" + Time(modified) + "}");
                if (!row.Earliest.HasValue || modified < row.Earliest) row.Earliest = modified;
                if (!row.Latest.HasValue || modified > row.Latest) row.Latest = modified;
            } else {
                Skip(entry.FullName, "special-file", row);
            }
            Notify(entry.FullName, false);
        }
        Emit(row);
        return row;
    }

    public static void Run(string requestedRoot, TextWriter stdout, TextWriter stderr, bool includeFileDetails) {
        string full = Path.GetFullPath(requestedRoot);
        string volume = Path.GetPathRoot(full);
        if (full.Length > volume.Length) full = full.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        DirectoryInfo directory = new DirectoryInfo(full);
        if (!directory.Exists) throw new ArgumentException("Root must be an existing directory.");
        for (DirectoryInfo current = directory; current != null; current = current.Parent) {
            if ((current.Attributes & FileAttributes.ReparsePoint) != 0) throw new ArgumentException("Root and its ancestors must not be reparse points.");
        }
        FwNativeSpaceScanner scan = new FwNativeSpaceScanner(directory.FullName, stdout, stderr, includeFileDetails);
        string started = Time(DateTime.UtcNow);
        stdout.Write("{\"schemaVersion\":2,\"scanner\":\"windows-native-cached-metadata\",\"root\":" + Quote(scan.root)
            + ",\"startedAt\":" + started + ",\"measurement\":\"logical-file-lengths\",\"consistentSnapshot\":false,\"inventoryEnabled\":true,\"fileDetailsEnabled\":" + (includeFileDetails ? "true" : "false") + ",\"inventory\":[");
        Row totals = scan.Visit(directory);
        bool complete = scan.errorCount == 0 && scan.skippedCount == 0;
        stdout.Write("],\"inventoryComplete\":true,\"finishedAt\":" + Time(DateTime.UtcNow) + ",\"elapsedMs\":" + scan.clock.ElapsedMilliseconds
            + ",\"totals\":" + RowJson(totals) + ",\"errorCount\":" + scan.errorCount + ",\"skippedCount\":" + scan.skippedCount
            + ",\"errors\":[" + String.Join(",", scan.errors.ToArray()) + "],\"skipped\":[" + String.Join(",", scan.skipped.ToArray())
            + "],\"measurementComplete\":" + (complete ? "true" : "false")
            + ",\"unmeasured\":{\"errorCount\":" + scan.errorCount + ",\"skippedCount\":" + scan.skippedCount
            + ",\"logicalBytes\":" + (complete ? "0" : "null") + ",\"errorsOmitted\":" + (scan.errorCount - scan.errors.Count)
            + ",\"skippedOmitted\":" + (scan.skippedCount - scan.skipped.Count) + "}}");
        stdout.WriteLine();
        stdout.Flush();
        scan.Notify(scan.root, true);
    }
}
'@

$taskProgressWriter = if ($Progress) { [Console]::Error } else { $null }
# Console.Out flushes each small write. Buffer the potentially large inventory;
# Notify and successful completion explicitly flush it without retaining the
# whole JSON document in memory. Leave the caller's stdout handle open.
$taskOutputWriter = [System.IO.StreamWriter]::new([Console]::OpenStandardOutput(), [System.Text.UTF8Encoding]::new($false), 1048576, $true)
try {
    [FwNativeSpaceScanner]::Run($Root, $taskOutputWriter, $taskProgressWriter, $FileDetails.IsPresent)
} finally {
    $taskOutputWriter.Dispose()
}
