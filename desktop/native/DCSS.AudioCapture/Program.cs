using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Threading;

namespace DCSS.AudioCapture
{
    public enum PROCESS_LOOPBACK_MODE
    {
        PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0,
        PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS
    {
        public uint TargetProcessId;
        public PROCESS_LOOPBACK_MODE ProcessLoopbackMode;
    }

    public enum AUDIOCLIENT_ACTIVATION_TYPE
    {
        AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT = 0,
        AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct AUDIOCLIENT_ACTIVATION_PARAMS
    {
        public AUDIOCLIENT_ACTIVATION_TYPE ActivationType;
        public AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROPVARIANT
    {
        public ushort vt; // VT_BLOB = 65
        public ushort wReserved1;
        public ushort wReserved2;
        public ushort wReserved3;
        public uint blob_cbSize;
        public IntPtr blob_pBlobData;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct WAVEFORMATEXTENSIBLE
    {
        public WAVEFORMATEX Format;
        public ushort wValidBitsPerSample;
        public uint dwChannelMask;
        public Guid SubFormat;
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90")]
    public interface IAgileObject
    {
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("72A2E436-0792-4981-A875-9610B5E68C6A")]
    public interface IActivateAudioInterfaceAsyncOperation
    {
        [PreserveSig]
        int GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("41D949AB-9862-444A-80F6-C261334DA5EB")]
    public interface IActivateAudioInterfaceCompletionHandler
    {
        [PreserveSig]
        int ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation);
    }

    public unsafe class NativeCompletionHandler : IDisposable
    {
        private static readonly Guid IID_IUnknown = new("00000000-0000-0000-C000-000000000046");
        private static readonly Guid IID_IAgileObject = new("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90");
        private static readonly Guid IID_ICompletionHandler = new("41D949AB-9862-444A-80F6-C261334DA5EB");

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int QueryInterfaceDelegate(IntPtr thisPtr, ref Guid riid, out IntPtr ppv);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate uint AddRefDelegate(IntPtr thisPtr);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate uint ReleaseDelegate(IntPtr thisPtr);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int ActivateCompletedDelegate(IntPtr thisPtr, IntPtr pAsyncOp);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int GetActivateResultDelegate(IntPtr thisPtr, out int activateResult, out IntPtr activatedInterface);

        private readonly ManualResetEvent _event = new(false);
        public int ResultHResult { get; private set; } = -1;
        public IntPtr ActivatedAudioClient { get; private set; } = IntPtr.Zero;

        private readonly QueryInterfaceDelegate _qi;
        private readonly AddRefDelegate _addRef;
        private readonly ReleaseDelegate _release;
        private readonly ActivateCompletedDelegate _activateCompleted;

        private readonly IntPtr _vtablePtr;
        public IntPtr InstancePtr { get; }

        public NativeCompletionHandler()
        {
            _qi = OnQueryInterface;
            _addRef = OnAddRef;
            _release = OnRelease;
            _activateCompleted = OnActivateCompleted;

            _vtablePtr = Marshal.AllocHGlobal(IntPtr.Size * 4);
            IntPtr* vtable = (IntPtr*)_vtablePtr;
            vtable[0] = Marshal.GetFunctionPointerForDelegate(_qi);
            vtable[1] = Marshal.GetFunctionPointerForDelegate(_addRef);
            vtable[2] = Marshal.GetFunctionPointerForDelegate(_release);
            vtable[3] = Marshal.GetFunctionPointerForDelegate(_activateCompleted);

            InstancePtr = Marshal.AllocHGlobal(IntPtr.Size);
            *(IntPtr*)InstancePtr = _vtablePtr;
        }

        private int OnQueryInterface(IntPtr thisPtr, ref Guid riid, out IntPtr ppv)
        {
            Console.Error.WriteLine($"[DEBUG QI] riid={riid}");
            if (riid == IID_IUnknown || riid == IID_ICompletionHandler || riid == IID_IAgileObject)
            {
                ppv = thisPtr;
                return 0; // S_OK
            }
            ppv = IntPtr.Zero;
            return unchecked((int)0x80004002); // E_NOINTERFACE
        }

        private uint OnAddRef(IntPtr thisPtr) => 1;
        private uint OnRelease(IntPtr thisPtr) => 1;

        private int OnActivateCompleted(IntPtr thisPtr, IntPtr pAsyncOp)
        {
            try
            {
                Console.Error.WriteLine("[DCSS.AudioCapture] Native ActivateCompleted called by Windows!");
                if (pAsyncOp != IntPtr.Zero)
                {
                    IntPtr* opVtable = *(IntPtr**)pAsyncOp;
                    var getResult = Marshal.GetDelegateForFunctionPointer<GetActivateResultDelegate>(opVtable[3]);
                    int hrOp = getResult(pAsyncOp, out int actResult, out IntPtr pInterface);
                    ResultHResult = actResult;
                    ActivatedAudioClient = pInterface;
                    Console.Error.WriteLine($"[DCSS.AudioCapture] GetActivateResult: hrOp=0x{hrOp:X8}, actResult=0x{actResult:X8}, pInterface=0x{pInterface.ToInt64():X8}");
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[DCSS.AudioCapture] Error in native ActivateCompleted: {ex}");
            }
            finally
            {
                _event.Set();
            }
            return 0;
        }

        public bool Wait(int timeoutMs) => _event.WaitOne(timeoutMs);

        public void Dispose()
        {
            Marshal.FreeHGlobal(InstancePtr);
            Marshal.FreeHGlobal(_vtablePtr);
        }
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2")]
    public interface IAudioClient
    {
        [PreserveSig]
        int Initialize(
            int shareMode,
            uint streamFlags,
            long hnsBufferDuration,
            long hnsPeriodicity,
            IntPtr pFormat,
            ref Guid audioSessionGuid);

        [PreserveSig]
        int GetBufferSize(out uint pNumBufferFrames);

        [PreserveSig]
        int GetStreamLatency(out long phnsLatency);

        [PreserveSig]
        int GetCurrentPadding(out uint pNumPaddingFrames);

        [PreserveSig]
        int IsFormatSupported(
            int shareMode,
            IntPtr pFormat,
            out IntPtr ppClosestMatch);

        [PreserveSig]
        int GetMixFormat(out IntPtr ppDeviceFormat);

        [PreserveSig]
        int GetDevicePeriod(out long phnsDefaultDevicePeriod, out long phnsMinimumDevicePeriod);

        [PreserveSig]
        int Start();

        [PreserveSig]
        int Stop();

        [PreserveSig]
        int Reset();

        [PreserveSig]
        int SetEventHandle(IntPtr eventHandle);

        [PreserveSig]
        int GetService(ref Guid riid, out IntPtr ppv);
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317")]
    public interface IAudioCaptureClient
    {
        [PreserveSig]
        int GetBuffer(
            out IntPtr ppData,
            out uint pNumFramesToRead,
            out uint pdwFlags,
            out ulong pu64DevicePosition,
            out ulong pu64QPCPosition);

        [PreserveSig]
        int ReleaseBuffer(uint numFramesRead);

        [PreserveSig]
        int GetNextPacketSize(out uint pNumFramesInNextPacket);
    }

    public class Program
    {
        private const string VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK = @"VAD\Process_Loopback";
        private const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
        private const uint AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000;
        private const uint AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM = 0x80000000;
        private const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
        private const int AUDCLNT_SHAREMODE_SHARED = 0;
        private const ushort VT_BLOB = 65;

        private static readonly Guid IID_IAudioClient = new("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
        private static readonly Guid IID_IAudioCaptureClient = new("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
        private static readonly Guid KSDATAFORMAT_SUBTYPE_IEEE_FLOAT = new("00000003-0000-0010-8000-00aa00389b71");

        [DllImport("Mmdevapi.dll", ExactSpelling = true)]
        private static extern int ActivateAudioInterfaceAsync(
            [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
            [In] ref Guid riid,
            IntPtr currentActivationParams,
            IntPtr completionHandler,
            out IntPtr activationOperation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateEvent(IntPtr lpEventAttributes, bool bManualReset, bool bInitialState, string? lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);


        [MTAThread]
        public static int Main(string[] args)
        {
            uint excludePid = 0;
            uint includePid = 0;
            int parentPid = 0;
            string? pipeName = null;
            int targetSampleRate = 48000;
            int targetChannels = 2;

            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--exclude-pid" && i + 1 < args.Length)
                {
                    uint.TryParse(args[++i], out excludePid);
                }
                else if (args[i] == "--include-pid" && i + 1 < args.Length)
                {
                    uint.TryParse(args[++i], out includePid);
                }
                else if (args[i] == "--parent-pid" && i + 1 < args.Length)
                {
                    int.TryParse(args[++i], out parentPid);
                }
                else if (args[i] == "--pipe" && i + 1 < args.Length)
                {
                    pipeName = args[++i];
                }
                else if (args[i] == "--sample-rate" && i + 1 < args.Length)
                {
                    int.TryParse(args[++i], out targetSampleRate);
                }
                else if (args[i] == "--channels" && i + 1 < args.Length)
                {
                    int.TryParse(args[++i], out targetChannels);
                }
            }

            // Watchdog: If parent process terminates, terminate immediately to prevent orphans
            if (parentPid > 0)
            {
                var watchdogThread = new Thread(() =>
                {
                    try
                    {
                        var parent = Process.GetProcessById(parentPid);
                        parent.WaitForExit();
                        Environment.Exit(0);
                    }
                    catch
                    {
                        Environment.Exit(0);
                    }
                })
                {
                    IsBackground = true
                };
                watchdogThread.Start();
            }

            Console.Error.WriteLine($"[DCSS.AudioCapture] Starting loopback capture: excludePid={excludePid}, includePid={includePid}, pipe={pipeName ?? "stdout"}, rate={targetSampleRate}, ch={targetChannels}");

            // Setup activation parameters
            IntPtr propVariantPtr = IntPtr.Zero;
            IntPtr activationParamsPtr = IntPtr.Zero;

            try
            {
                AUDIOCLIENT_ACTIVATION_PARAMS actParams = new();
                actParams.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE.AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
                actParams.ProcessLoopbackParams.TargetProcessId = excludePid > 0 ? excludePid : includePid;
                actParams.ProcessLoopbackParams.ProcessLoopbackMode = excludePid > 0
                    ? PROCESS_LOOPBACK_MODE.PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
                    : PROCESS_LOOPBACK_MODE.PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

                activationParamsPtr = Marshal.AllocHGlobal(Marshal.SizeOf<AUDIOCLIENT_ACTIVATION_PARAMS>());
                Marshal.StructureToPtr(actParams, activationParamsPtr, false);

                Console.Error.WriteLine($"[DEBUG] SizeOf(PROPVARIANT)={Marshal.SizeOf<PROPVARIANT>()}, offset(cbSize)={Marshal.OffsetOf<PROPVARIANT>("blob_cbSize")}, offset(pBlobData)={Marshal.OffsetOf<PROPVARIANT>("blob_pBlobData")}, SizeOf(AUDIOCLIENT_ACTIVATION_PARAMS)={Marshal.SizeOf<AUDIOCLIENT_ACTIVATION_PARAMS>()}");
                PROPVARIANT propVariant = new();
                propVariant.vt = VT_BLOB;
                propVariant.blob_cbSize = (uint)Marshal.SizeOf<AUDIOCLIENT_ACTIVATION_PARAMS>();
                propVariant.blob_pBlobData = activationParamsPtr;

                propVariantPtr = Marshal.AllocHGlobal(Marshal.SizeOf<PROPVARIANT>());
                Marshal.StructureToPtr(propVariant, propVariantPtr, false);

                using var handler = new NativeCompletionHandler();
                Guid audioClientGuid = IID_IAudioClient;
                IntPtr activationOp = IntPtr.Zero;

                Console.Error.WriteLine("[DCSS.AudioCapture] Calling ActivateAudioInterfaceAsync with NativeCompletionHandler...");
                int actHr = ActivateAudioInterfaceAsync(
                    VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                    ref audioClientGuid,
                    propVariantPtr,
                    handler.InstancePtr,
                    out activationOp
                );

                if (actHr != 0)
                {
                    Console.Error.WriteLine($"[DCSS.AudioCapture] Error: ActivateAudioInterfaceAsync call returned HRESULT 0x{actHr:X8}");
                    return 1;
                }

                if (!handler.Wait(5000))
                {
                    Console.Error.WriteLine("[DCSS.AudioCapture] Error: Native ActivateAudioInterfaceAsync timed out after 5s.");
                    return 1;
                }

                if (handler.ResultHResult != 0 || handler.ActivatedAudioClient == IntPtr.Zero)
                {
                    Console.Error.WriteLine($"[DCSS.AudioCapture] Error: ActivateAudioInterfaceAsync failed with HRESULT 0x{handler.ResultHResult:X8}");
                    return 2;
                }

                var audioClient = (IAudioClient)Marshal.GetObjectForIUnknown(handler.ActivatedAudioClient);

                WAVEFORMATEX waveFormat = new()
                {
                    wFormatTag = 1, // WAVE_FORMAT_PCM
                    nChannels = (ushort)targetChannels,
                    nSamplesPerSec = (uint)targetSampleRate,
                    wBitsPerSample = 16,
                    nBlockAlign = (ushort)(targetChannels * 16 / 8),
                    nAvgBytesPerSec = (uint)(targetSampleRate * targetChannels * 16 / 8),
                    cbSize = 0
                };

                IntPtr pFormat = Marshal.AllocHGlobal(Marshal.SizeOf<WAVEFORMATEX>());
                Marshal.StructureToPtr(waveFormat, pFormat, false);

                Console.Error.WriteLine($"[DCSS.AudioCapture] Format: {waveFormat.nSamplesPerSec}Hz, {waveFormat.nChannels} channels, {waveFormat.wBitsPerSample} bits PCM (AUTOCONVERTPCM)");

                IntPtr hCaptureEvent = CreateEvent(IntPtr.Zero, false, false, null);

                // Initialize loopback client
                long hnsBufferDuration = 1000000; // 100 ms in 100-nanosecond units
                Guid sessionGuid = Guid.Empty;
                int hr = audioClient.Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                    hnsBufferDuration,
                    0,
                    pFormat,
                    ref sessionGuid
                );

                if (hr != 0)
                {
                    Console.Error.WriteLine($"[DCSS.AudioCapture] Error: AudioClient.Initialize failed with HRESULT 0x{hr:X8}");
                    return 4;
                }

                audioClient.SetEventHandle(hCaptureEvent);

                Guid captureGuid = IID_IAudioCaptureClient;
                int hrService = audioClient.GetService(ref captureGuid, out IntPtr pCapture);
                Console.Error.WriteLine($"[DCSS.AudioCapture] GetService: hr=0x{hrService:X8}, pCapture=0x{pCapture.ToInt64():X8}");
                if (hrService != 0 || pCapture == IntPtr.Zero)
                {
                    Console.Error.WriteLine($"[DCSS.AudioCapture] Error: GetService(IAudioCaptureClient) failed with HRESULT 0x{hrService:X8}");
                    return 5;
                }
                var captureClient = (IAudioCaptureClient)Marshal.GetObjectForIUnknown(pCapture);

                audioClient.Start();
                Console.Error.WriteLine("[DCSS.AudioCapture] Audio loopback client started successfully. Streaming PCM (s16le 48kHz stereo)...");

                // Prepare output stream
                Stream outputStream;
                NamedPipeServerStream? pipeServer = null;

                if (!string.IsNullOrEmpty(pipeName))
                {
                    pipeServer = new NamedPipeServerStream(
                        pipeName,
                        PipeDirection.Out,
                        1,
                        PipeTransmissionMode.Byte,
                        PipeOptions.Asynchronous
                    );
                    Console.Error.WriteLine($"[DCSS.AudioCapture] Waiting for client connection on pipe \\\\.\\pipe\\{pipeName}...");
                    pipeServer.WaitForConnection();
                    Console.Error.WriteLine("[DCSS.AudioCapture] Pipe client connected.");
                    outputStream = pipeServer;
                }
                else
                {
                    outputStream = Console.OpenStandardOutput();
                }

                bool isFloat = false;
                int srcChannels = waveFormat.nChannels;
                int srcRate = (int)waveFormat.nSamplesPerSec;

                // Processing loop
                byte[] conversionBuffer = new byte[8192 * 4];

                while (true)
                {
                    uint waitRes = WaitForSingleObject(hCaptureEvent, 2000);
                    if (waitRes != 0)
                    {
                        // Timeout or error
                        continue;
                    }

                    while (captureClient.GetNextPacketSize(out uint packetLength) == 0 && packetLength > 0)
                    {
                        hr = captureClient.GetBuffer(
                            out IntPtr pData,
                            out uint numFramesRead,
                            out uint flags,
                            out _,
                            out _
                        );

                        if (hr != 0) break;

                        if (numFramesRead > 0)
                        {
                            bool isSilent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
                            int outBytes = ProcessAndConvertAudio(
                                pData,
                                numFramesRead,
                                srcChannels,
                                srcRate,
                                isFloat,
                                isSilent,
                                targetChannels,
                                targetSampleRate,
                                ref conversionBuffer
                            );

                            if (outBytes > 0)
                            {
                                try
                                {
                                    outputStream.Write(conversionBuffer, 0, outBytes);
                                }
                                catch (Exception ex)
                                {
                                    Console.Error.WriteLine($"[DCSS.AudioCapture] Output stream write error: {ex.Message}");
                                    return 0; // Pipe broken or closed by parent
                                }
                            }
                        }

                        captureClient.ReleaseBuffer(numFramesRead);
                    }
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[DCSS.AudioCapture] Fatal exception: {ex}");
                return 99;
            }
            finally
            {
                if (propVariantPtr != IntPtr.Zero) Marshal.FreeHGlobal(propVariantPtr);
                if (activationParamsPtr != IntPtr.Zero) Marshal.FreeHGlobal(activationParamsPtr);
            }
        }

        private static unsafe int ProcessAndConvertAudio(
            IntPtr pData,
            uint numFrames,
            int srcChannels,
            int srcRate,
            bool isFloat,
            bool isSilent,
            int dstChannels,
            int dstRate,
            ref byte[] buffer)
        {
            // If sample rates match (48kHz -> 48kHz, stereo -> stereo)
            if (srcRate == dstRate && srcChannels == dstChannels)
            {
                int totalSamples = (int)numFrames * dstChannels;
                int neededBytes = totalSamples * 2; // 16-bit PCM = 2 bytes/sample
                if (buffer.Length < neededBytes) Array.Resize(ref buffer, neededBytes);

                if (isSilent || pData == IntPtr.Zero)
                {
                    Array.Clear(buffer, 0, neededBytes);
                    return neededBytes;
                }

                fixed (byte* pOut = buffer)
                {
                    short* pOutShort = (short*)pOut;
                    if (isFloat)
                    {
                        float* pInFloat = (float*)pData;
                        for (int i = 0; i < totalSamples; i++)
                        {
                            float sample = pInFloat[i];
                            if (sample > 1.0f) sample = 1.0f;
                            else if (sample < -1.0f) sample = -1.0f;
                            pOutShort[i] = (short)(sample * 32767.0f);
                        }
                    }
                    else
                    {
                        short* pInShort = (short*)pData;
                        Buffer.MemoryCopy(pInShort, pOutShort, neededBytes, neededBytes);
                    }
                }
                return neededBytes;
            }
            else
            {
                // Resample (linear interpolation)
                double ratio = (double)dstRate / srcRate;
                int dstFrames = (int)Math.Round(numFrames * ratio);
                int totalDstSamples = dstFrames * dstChannels;
                int neededBytes = totalDstSamples * 2;
                if (buffer.Length < neededBytes) Array.Resize(ref buffer, neededBytes);

                if (isSilent || pData == IntPtr.Zero)
                {
                    Array.Clear(buffer, 0, neededBytes);
                    return neededBytes;
                }

                fixed (byte* pOut = buffer)
                {
                    short* pOutShort = (short*)pOut;
                    float* pInFloat = (float*)pData;

                    for (int f = 0; f < dstFrames; f++)
                    {
                        double srcFrameExact = f / ratio;
                        int srcFrame0 = (int)Math.Floor(srcFrameExact);
                        int srcFrame1 = Math.Min(srcFrame0 + 1, (int)numFrames - 1);
                        float frac = (float)(srcFrameExact - srcFrame0);

                        for (int ch = 0; ch < dstChannels; ch++)
                        {
                            int inCh = Math.Min(ch, srcChannels - 1);
                            float s0 = isFloat ? pInFloat[srcFrame0 * srcChannels + inCh] : (((short*)pData)[srcFrame0 * srcChannels + inCh] / 32768.0f);
                            float s1 = isFloat ? pInFloat[srcFrame1 * srcChannels + inCh] : (((short*)pData)[srcFrame1 * srcChannels + inCh] / 32768.0f);
                            float sample = s0 + (s1 - s0) * frac;

                            if (sample > 1.0f) sample = 1.0f;
                            else if (sample < -1.0f) sample = -1.0f;

                            pOutShort[f * dstChannels + ch] = (short)(sample * 32767.0f);
                        }
                    }
                }
                return neededBytes;
            }
        }
    }
}
