import { EventEmitter } from 'node:events';
import * as grpc from '@grpc/grpc-js';
import { SliverRPCClient } from '../grpc/rpcpb/services';
import { Empty } from '../grpc/commonpb/common';
import {
  Beacons,
  Beacon,
  BeaconTask,
  BeaconTasks,
  BackdoorReq,
  Credential,
  Credentials as CredentialsMsg,
  DeepPartial,
  DeleteReq,
  DllHijackReq,
  Event,
  Generate,
  GenerateReq,
  GenerateStageReq,
  ExternalGenerateReq,
  ExternalImplantConfig,
  GetSystemReq,
  Host as HostMsg,
  IOC,
  ImplantProfile,
  Jobs,
  KillJob,
  KillJobReq,
  ListenerJob,
  Loot as LootMsg,
  CertificatesReq,
  MigrateReq,
  MonitoringProvider,
  MSFReq,
  MSFRemoteReq,
  MTLSListenerReq,
  HTTPListenerReq,
  DNSListenerReq,
  StagerListenerReq,
  WGListenerReq,
  RegenerateReq,
  RenameReq,
  RestartJobReq,
  Sessions,
  Version,
  Website,
  WebsiteAddContent,
  WebsiteRemoveContent,
  C2ProfileReq,
  HTTPC2ConfigReq,
  HTTPC2Config,
} from '../grpc/clientpb/client';
import {
  CallExtensionReq,
  CdReq,
  ChmodReq,
  ChownReq,
  ChtimesReq,
  CloseSession,
  CpReq,
  CurrentTokenOwnerReq,
  DownloadReq,
  EnvReq,
  Execute,
  ExecuteReq,
  ExecuteAssemblyReq,
  ExecuteWindowsReq,
  GetPrivsReq,
  GrepReq,
  IfconfigReq,
  ImpersonateReq,
  InvokeSpawnDllReq,
  KillReq,
  ListExtensionsReq,
  ReconfigureReq,
  LsReq,
  MakeTokenReq,
  MemfilesAddReq,
  MemfilesListReq,
  MemfilesRmReq,
  MkdirReq,
  MountReq,
  MvReq,
  NetstatReq,
  OpenSession,
  PivotListenersReq,
  PivotStartListenerReq,
  PivotStopListenerReq,
  PortfwdReq,
  ProcessDumpReq,
  Ps,
  PsReq,
  PwdReq,
  RegistryCreateKeyReq,
  RegistryDeleteKeyReq,
  RegistryListValuesReq,
  RegistryReadHiveReq,
  RegistryReadReq,
  RegistrySubKeyListReq,
  RegistryWriteReq,
  RemoveServiceReq,
  RevToSelfReq,
  RmReq,
  RportFwdListenersReq,
  RportFwdStartListenerReq,
  RportFwdStopListenerReq,
  RunAsReq,
  ScreenshotReq,
  ServiceDetailReq,
  ServicesReq,
  SetEnvReq,
  Shell,
  ShellReq,
  SideloadReq,
  Socks,
  SSHCommandReq,
  StartServiceReq,
  StartServiceByNameReq,
  StopServiceReq,
  TaskReq,
  TerminateReq,
  Tunnel,
  TunnelData,
  UnsetEnvReq,
  UploadReq,
  WGPortForwardStartReq,
  WGPortForwardStopReq,
  WGSocksStartReq,
  WGSocksStopReq,
  WGTCPForwardersReq,
  WGSocksServersReq,
} from '../grpc/sliverpb/sliver';
import { OperatorConfig } from './OperatorConfig';
import { log } from '../util/logger';

const MAX_MSG = 2 * 1024 * 1024 * 1024 - 1; // ~2GB, matches the Sliver console client

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

/**
 * One operator <-> sliver-server connection. Owns the gRPC channel, the mTLS
 * credentials, the long-lived Events stream (with auto-reconnect), and typed
 * wrappers over the RPC methods the UI needs.
 *
 * Emits:
 *   'event'      (Event)            — a server event arrived on the stream
 *   'state'      (ConnectionState)  — connection state changed
 *   'error'      (Error)            — a non-fatal stream/connection error
 */
export class SliverClient extends EventEmitter {
  private rpc?: SliverRPCClient;
  private eventStream?: grpc.ClientReadableStream<Event>;
  private _state: ConnectionState = 'disconnected';
  private disposed = false;
  private reconnectAttempts = 0;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(readonly config: OperatorConfig) {
    super();
  }

  get state(): ConnectionState {
    return this._state;
  }

  private setState(state: ConnectionState): void {
    if (this._state !== state) {
      this._state = state;
      this.emit('state', state);
    }
  }

  private buildCredentials(): grpc.ChannelCredentials {
    const ca = Buffer.from(this.config.ca_certificate);
    const key = Buffer.from(this.config.private_key);
    const cert = Buffer.from(this.config.certificate);

    // Sliver server certs are self-signed; verify the chain against the bundled
    // CA but skip hostname matching (the cert CN is rarely the dial host).
    const ssl = grpc.credentials.createSsl(ca, key, cert, {
      checkServerIdentity: () => undefined,
    });

    const token = this.config.token;
    const callCreds = grpc.credentials.createFromMetadataGenerator((_params, cb) => {
      const md = new grpc.Metadata();
      md.add('Authorization', `Bearer ${token}`);
      cb(null, md);
    });

    return grpc.credentials.combineChannelCredentials(ssl, callCreds);
  }

  /**
   * Establish the channel, validate creds with a GetVersion handshake, then
   * subscribe to the Events stream. Throws if the handshake fails.
   */
  async connect(): Promise<Version> {
    if (this._state === 'connected') {
      return this.getVersion();
    }
    this.disposed = false;
    this.setState('connecting');

    const target = `${this.config.lhost}:${this.config.lport}`;
    this.rpc = new SliverRPCClient(target, this.buildCredentials(), {
      'grpc.max_receive_message_length': MAX_MSG,
      'grpc.max_send_message_length': MAX_MSG,
      'grpc.keepalive_time_ms': 30_000,
      // Sliver servers are dialed by IP, but Node's TLS stack refuses to use an
      // IP as the SNI servername. Override it with a placeholder hostname; the
      // value is irrelevant because hostname verification is disabled above.
      'grpc.ssl_target_name_override': 'sliver',
      'grpc.default_authority': 'sliver',
    });

    try {
      const version = await this.getVersion();
      this.reconnectAttempts = 0;
      this.subscribeEvents();
      this.setState('connected');
      log.info(`Connected to ${target} (server v${version.Major}.${version.Minor}.${version.Patch})`);
      return version;
    } catch (err) {
      this.setState('disconnected');
      this.rpc?.close();
      this.rpc = undefined;
      throw err;
    }
  }

  disconnect(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.eventStream?.cancel();
    this.eventStream = undefined;
    this.rpc?.close();
    this.rpc = undefined;
    this.setState('disconnected');
  }

  dispose(): void {
    this.disconnect();
    this.removeAllListeners();
  }

  // --- Events stream with reconnection ----------------------------------

  private subscribeEvents(): void {
    if (!this.rpc) {
      return;
    }
    const stream = this.rpc.events(Empty.create({}));
    this.eventStream = stream;

    stream.on('data', (event: Event) => this.emit('event', event));
    stream.on('error', (err: Error) => {
      if (this.disposed) {
        return;
      }
      log.warn(`Events stream error: ${err.message}`);
      this.emit('error', err);
      this.scheduleReconnect();
    });
    stream.on('end', () => {
      if (!this.disposed) {
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) {
      return;
    }
    this.setState('connecting');
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000);
    this.reconnectAttempts++;
    log.info(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      try {
        await this.getVersion(); // channel auto-reconnects unary; this is the probe
        this.reconnectAttempts = 0;
        this.subscribeEvents();
        this.setState('connected');
        log.info('Reconnected; event stream resubscribed');
      } catch (err) {
        log.warn(`Reconnect failed: ${(err as Error).message}`);
        this.scheduleReconnect();
      }
    }, delay);
  }

  // --- Unary RPC helpers -------------------------------------------------

  private get client(): SliverRPCClient {
    if (!this.rpc) {
      throw new Error('Not connected');
    }
    return this.rpc;
  }

  /**
   * Promisify a callback-style unary RPC. Returns `any` because the generated
   * client methods are overloaded (defeating response-type inference); the
   * typed core methods below re-annotate their own return types for callers.
   */
  private unary<TReq>(
    method: (req: TReq, cb: (err: grpc.ServiceError | null, res: any) => void) => unknown,
    req: TReq,
  ): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      method.call(this.client, req, (err, res) => {
        if (err) {
          reject(err);
        } else {
          resolve(res);
        }
      });
    });
  }

  /**
   * Escape hatch: invoke ANY unary gRPC method on this authenticated channel by
   * its fully-qualified path (e.g. "/rpcpb.SliverRPC/GetVersion"), sending raw
   * request bytes and returning raw response bytes. Bypasses the typed stub —
   * the caller marshals/unmarshals the protobuf. Works for methods the stub
   * doesn't wrap, and for custom endpoints on a forked server. Same mTLS creds
   * and bearer token as every other call.
   */
  rawUnary(methodPath: string, requestBytes: Buffer): Promise<Buffer> {
    const passthrough = (b: Buffer): Buffer => b;
    return new Promise<Buffer>((resolve, reject) => {
      // makeUnaryRequest lives on the underlying @grpc/grpc-js Client.
      (this.client as unknown as grpc.Client).makeUnaryRequest(
        methodPath,
        passthrough,
        passthrough,
        requestBytes,
        (err: grpc.ServiceError | null, res?: Buffer) => (err ? reject(err) : resolve(res ?? Buffer.alloc(0))),
      );
    });
  }

  getVersion(): Promise<Version> {
    return this.unary(this.client.getVersion, Empty.create({}));
  }
  getSessions(): Promise<Sessions> {
    return this.unary(this.client.getSessions, Empty.create({}));
  }
  getBeacons(): Promise<Beacons> {
    return this.unary(this.client.getBeacons, Empty.create({}));
  }
  getJobs(): Promise<Jobs> {
    return this.unary(this.client.getJobs, Empty.create({}));
  }
  getBeaconTasks(beaconId: string): Promise<BeaconTasks> {
    return this.unary(this.client.getBeaconTasks, Beacon.fromPartial({ ID: beaconId }));
  }

  /** Run a command. For beacons pass async=true; the result is queued. */
  execute(req: DeepPartial<ExecuteReq>): Promise<Execute> {
    return this.unary(this.client.execute, ExecuteReq.fromPartial(req));
  }
  ps(req: DeepPartial<PsReq>): Promise<Ps> {
    return this.unary(this.client.ps, PsReq.fromPartial(req));
  }
  killSession(sessionId: string, force = true): Promise<unknown> {
    return this.unary(
      this.client.kill,
      KillReq.fromPartial({ Force: force, Request: { SessionID: sessionId } }),
    );
  }
  killJob(jobId: number): Promise<KillJob> {
    return this.unary(this.client.killJob, KillJobReq.fromPartial({ ID: jobId }));
  }
  generate(req: DeepPartial<GenerateReq>): Promise<Generate> {
    return this.unary(this.client.generate, GenerateReq.fromPartial(req));
  }
  /** Build a stager shellcode payload from a saved profile (optionally AES/RC4 encrypted, compressed). */
  generateStage(req: DeepPartial<GenerateStageReq>): Promise<Generate> {
    return this.unary(this.client.generateStage, GenerateStageReq.fromPartial(req));
  }
  /**
   * Hand a build off to an external builder (e.g. tsh-builder). Returns the
   * resolved ExternalImplantConfig (with Build.ID) once the job is dispatched —
   * the binary is produced asynchronously by the builder, then appears under
   * Server → Implant Builds for download. Does NOT return the file directly.
   */
  generateExternal(req: DeepPartial<ExternalGenerateReq>): Promise<ExternalImplantConfig> {
    return this.unary(this.client.generateExternal, ExternalGenerateReq.fromPartial(req));
  }

  startMtlsListener(req: DeepPartial<MTLSListenerReq>): Promise<ListenerJob> {
    return this.unary(this.client.startMtlsListener, MTLSListenerReq.fromPartial(req));
  }
  startHttpListener(req: DeepPartial<HTTPListenerReq>): Promise<ListenerJob> {
    return this.unary(this.client.startHttpListener, HTTPListenerReq.fromPartial(req));
  }
  startHttpsListener(req: DeepPartial<HTTPListenerReq>): Promise<ListenerJob> {
    return this.unary(this.client.startHttpsListener, HTTPListenerReq.fromPartial(req));
  }
  startDnsListener(req: DeepPartial<DNSListenerReq>): Promise<ListenerJob> {
    return this.unary(this.client.startDnsListener, DNSListenerReq.fromPartial(req));
  }

  // --- Session/beacon management ----------------------------------------
  rename(req: DeepPartial<RenameReq>) {
    return this.unary(this.client.rename, RenameReq.fromPartial(req));
  }
  rmBeacon(beaconId: string) {
    return this.unary(this.client.rmBeacon, Beacon.fromPartial({ ID: beaconId }));
  }
  getBeaconTaskContent(taskId: string) {
    return this.unary(this.client.getBeaconTaskContent, BeaconTask.fromPartial({ ID: taskId }));
  }
  cancelBeaconTask(taskId: string) {
    return this.unary(this.client.cancelBeaconTask, BeaconTask.fromPartial({ ID: taskId }));
  }
  getOperators() {
    return this.unary(this.client.getOperators, Empty.create({}));
  }
  restartJobs(jobIds: number[]) {
    return this.unary(this.client.restartJobs, RestartJobReq.fromPartial({ JobIDs: jobIds }));
  }
  /** Reconfigure a live session/beacon: reconnect interval, beacon interval/jitter, active C2. */
  reconfigure(req: DeepPartial<ReconfigureReq>) {
    return this.unary(this.client.reconfigure, ReconfigureReq.fromPartial(req));
  }

  // --- File system ------------------------------------------------------
  ls(req: DeepPartial<LsReq>) {
    return this.unary(this.client.ls, LsReq.fromPartial(req));
  }
  cd(req: DeepPartial<CdReq>) {
    return this.unary(this.client.cd, CdReq.fromPartial(req));
  }
  pwd(req: DeepPartial<PwdReq>) {
    return this.unary(this.client.pwd, PwdReq.fromPartial(req));
  }
  mkdir(req: DeepPartial<MkdirReq>) {
    return this.unary(this.client.mkdir, MkdirReq.fromPartial(req));
  }
  rm(req: DeepPartial<RmReq>) {
    return this.unary(this.client.rm, RmReq.fromPartial(req));
  }
  mv(req: DeepPartial<MvReq>) {
    return this.unary(this.client.mv, MvReq.fromPartial(req));
  }
  download(req: DeepPartial<DownloadReq>) {
    return this.unary(this.client.download, DownloadReq.fromPartial(req));
  }
  upload(req: DeepPartial<UploadReq>) {
    return this.unary(this.client.upload, UploadReq.fromPartial(req));
  }

  // --- Recon / processes ------------------------------------------------
  screenshot(sessionId: string) {
    return this.unary(this.client.screenshot, ScreenshotReq.fromPartial({ Request: { SessionID: sessionId } }));
  }
  ifconfig(sessionId: string) {
    return this.unary(this.client.ifconfig, IfconfigReq.fromPartial({ Request: { SessionID: sessionId } }));
  }
  netstat(req: DeepPartial<NetstatReq>) {
    return this.unary(this.client.netstat, NetstatReq.fromPartial(req));
  }
  terminate(req: DeepPartial<TerminateReq>) {
    return this.unary(this.client.terminate, TerminateReq.fromPartial(req));
  }
  processDump(req: DeepPartial<ProcessDumpReq>) {
    return this.unary(this.client.processDump, ProcessDumpReq.fromPartial(req));
  }
  getEnv(req: DeepPartial<EnvReq>) {
    return this.unary(this.client.getEnv, EnvReq.fromPartial(req));
  }
  setEnv(req: DeepPartial<SetEnvReq>) {
    return this.unary(this.client.setEnv, SetEnvReq.fromPartial(req));
  }
  unsetEnv(req: DeepPartial<UnsetEnvReq>) {
    return this.unary(this.client.unsetEnv, UnsetEnvReq.fromPartial(req));
  }
  services(req: DeepPartial<ServicesReq>) {
    return this.unary(this.client.services, ServicesReq.fromPartial(req));
  }
  registryRead(req: DeepPartial<RegistryReadReq>) {
    return this.unary(this.client.registryRead, RegistryReadReq.fromPartial(req));
  }
  registryWrite(req: DeepPartial<RegistryWriteReq>) {
    return this.unary(this.client.registryWrite, RegistryWriteReq.fromPartial(req));
  }

  // --- Post-exploitation execution --------------------------------------
  executeAssembly(req: DeepPartial<ExecuteAssemblyReq>) {
    return this.unary(this.client.executeAssembly, ExecuteAssemblyReq.fromPartial(req));
  }
  sideload(req: DeepPartial<SideloadReq>) {
    return this.unary(this.client.sideload, SideloadReq.fromPartial(req));
  }
  spawnDll(req: DeepPartial<InvokeSpawnDllReq>) {
    return this.unary(this.client.spawnDll, InvokeSpawnDllReq.fromPartial(req));
  }
  migrate(req: DeepPartial<MigrateReq>) {
    return this.unary(this.client.migrate, MigrateReq.fromPartial(req));
  }
  msf(req: DeepPartial<MSFReq>) {
    return this.unary(this.client.msf, MSFReq.fromPartial(req));
  }
  runSSHCommand(req: DeepPartial<SSHCommandReq>) {
    return this.unary(this.client.runSshCommand, SSHCommandReq.fromPartial(req));
  }

  // --- Privilege / tokens (Windows) -------------------------------------
  getSystem(req: DeepPartial<GetSystemReq>) {
    return this.unary(this.client.getSystem, GetSystemReq.fromPartial(req));
  }
  impersonate(req: DeepPartial<ImpersonateReq>) {
    return this.unary(this.client.impersonate, ImpersonateReq.fromPartial(req));
  }
  runAs(req: DeepPartial<RunAsReq>) {
    return this.unary(this.client.runAs, RunAsReq.fromPartial(req));
  }
  revToSelf(sessionId: string) {
    return this.unary(this.client.revToSelf, RevToSelfReq.fromPartial({ Request: { SessionID: sessionId } }));
  }
  getPrivs(sessionId: string) {
    return this.unary(this.client.getPrivs, GetPrivsReq.fromPartial({ Request: { SessionID: sessionId } }));
  }
  makeToken(req: DeepPartial<MakeTokenReq>) {
    return this.unary(this.client.makeToken, MakeTokenReq.fromPartial(req));
  }
  currentTokenOwner(sessionId: string) {
    return this.unary(
      this.client.currentTokenOwner,
      CurrentTokenOwnerReq.fromPartial({ Request: { SessionID: sessionId } }),
    );
  }

  // --- Pivoting ---------------------------------------------------------
  portfwd(req: DeepPartial<PortfwdReq>) {
    return this.unary(this.client.portfwd, PortfwdReq.fromPartial(req));
  }
  createSocks(req: DeepPartial<Socks>) {
    return this.unary(this.client.createSocks, Socks.fromPartial(req));
  }
  closeSocks(req: DeepPartial<Socks>) {
    return this.unary(this.client.closeSocks, Socks.fromPartial(req));
  }
  /** Open the bidirectional SOCKS proxy stream (one per local SOCKS server). */
  openSocksProxy(): grpc.ClientDuplexStream<any, any> {
    return this.client.socksProxy();
  }
  startRportFwdListener(req: DeepPartial<RportFwdStartListenerReq>) {
    return this.unary(this.client.startRportFwdListener, RportFwdStartListenerReq.fromPartial(req));
  }
  getRportFwdListeners(sessionId: string) {
    return this.unary(
      this.client.getRportFwdListeners,
      RportFwdListenersReq.fromPartial({ Request: { SessionID: sessionId } }),
    );
  }
  stopRportFwdListener(req: DeepPartial<RportFwdStopListenerReq>) {
    return this.unary(this.client.stopRportFwdListener, RportFwdStopListenerReq.fromPartial(req));
  }

  // --- Extensions -------------------------------------------------------
  listExtensions(sessionId: string) {
    return this.unary(
      this.client.listExtensions,
      ListExtensionsReq.fromPartial({ Request: { SessionID: sessionId } }),
    );
  }
  callExtension(req: DeepPartial<CallExtensionReq>) {
    return this.unary(this.client.callExtension, CallExtensionReq.fromPartial(req));
  }

  // --- Data: loot / creds / hosts ---------------------------------------
  lootAll() {
    return this.unary(this.client.lootAll, Empty.create({}));
  }
  lootRm(lootId: string) {
    return this.unary(this.client.lootRm, LootMsg.fromPartial({ ID: lootId }));
  }
  lootContent(lootId: string) {
    return this.unary(this.client.lootContent, LootMsg.fromPartial({ ID: lootId }));
  }
  lootAdd(loot: DeepPartial<LootMsg>) {
    return this.unary(this.client.lootAdd, LootMsg.fromPartial(loot));
  }
  /** Update an existing loot record (e.g. rename). */
  lootUpdate(loot: DeepPartial<LootMsg>) {
    return this.unary(this.client.lootUpdate, LootMsg.fromPartial(loot));
  }
  host(hostUuid: string) {
    return this.unary(this.client.host, HostMsg.fromPartial({ HostUUID: hostUuid }));
  }
  websiteAddContent(req: DeepPartial<WebsiteAddContent>) {
    return this.unary(this.client.websiteAddContent, WebsiteAddContent.fromPartial(req));
  }
  websiteRemoveContent(req: DeepPartial<WebsiteRemoveContent>) {
    return this.unary(this.client.websiteRemoveContent, WebsiteRemoveContent.fromPartial(req));
  }
  /** Replace the bytes/content-type of content already served by a website. */
  websiteUpdateContent(req: DeepPartial<WebsiteAddContent>) {
    return this.unary(this.client.websiteUpdateContent, WebsiteAddContent.fromPartial(req));
  }
  getWebsite(name: string) {
    return this.unary(this.client.website, Website.fromPartial({ Name: name }));
  }
  creds() {
    return this.unary(this.client.creds, Empty.create({}));
  }
  credsAdd(creds: DeepPartial<Credential>[]) {
    return this.unary(this.client.credsAdd, CredentialsMsg.fromPartial({ Credentials: creds }));
  }
  credsRm(creds: DeepPartial<Credential>[]) {
    return this.unary(this.client.credsRm, CredentialsMsg.fromPartial({ Credentials: creds }));
  }
  /** Update existing credential records (match by ID). */
  credsUpdate(creds: DeepPartial<Credential>[]) {
    return this.unary(this.client.credsUpdate, CredentialsMsg.fromPartial({ Credentials: creds }));
  }
  hosts() {
    return this.unary(this.client.hosts, Empty.create({}));
  }
  hostRm(hostUuid: string) {
    return this.unary(this.client.hostRm, HostMsg.fromPartial({ HostUUID: hostUuid }));
  }
  /** Remove a single IOC (dropped-file record) from a host, for cleanup tracking. */
  hostIocRm(ioc: DeepPartial<IOC>) {
    return this.unary(this.client.hostIocRm, IOC.fromPartial(ioc));
  }

  // --- Payloads / implants ----------------------------------------------
  implantBuilds() {
    return this.unary(this.client.implantBuilds, Empty.create({}));
  }
  deleteImplantBuild(name: string) {
    return this.unary(this.client.deleteImplantBuild, DeleteReq.fromPartial({ Name: name }));
  }
  implantProfiles() {
    return this.unary(this.client.implantProfiles, Empty.create({}));
  }
  deleteImplantProfile(name: string) {
    return this.unary(this.client.deleteImplantProfile, DeleteReq.fromPartial({ Name: name }));
  }
  saveImplantProfile(profile: DeepPartial<ImplantProfile>) {
    return this.unary(this.client.saveImplantProfile, ImplantProfile.fromPartial(profile));
  }
  regenerate(name: string) {
    return this.unary(this.client.regenerate, RegenerateReq.fromPartial({ ImplantName: name }));
  }
  canaries() {
    return this.unary(this.client.canaries, Empty.create({}));
  }
  getCompiler() {
    return this.unary(this.client.getCompiler, Empty.create({}));
  }

  // --- Websites / C2 profiles / monitoring ------------------------------
  websites() {
    return this.unary(this.client.websites, Empty.create({}));
  }
  websiteRemove(name: string) {
    return this.unary(this.client.websiteRemove, Website.fromPartial({ Name: name }));
  }
  getHttpC2Profiles() {
    return this.unary(this.client.getHttpc2Profiles, Empty.create({}));
  }
  getHttpC2ProfileByName(name: string) {
    return this.unary(this.client.getHttpc2ProfileByName, C2ProfileReq.fromPartial({ Name: name }));
  }
  saveHttpC2Profile(config: DeepPartial<HTTPC2Config>, overwrite = true) {
    return this.unary(this.client.saveHttpc2Profile, HTTPC2ConfigReq.fromPartial({ C2Config: config, overwrite }));
  }
  /**
   * Whether a named HTTP-C2 profile exists. Must be checked against the list —
   * GetHTTPC2ProfileByName does NOT error on a missing name (it returns an
   * empty config with Name=""), so it can't be used to probe existence. Used to
   * pick the SaveHTTPC2Profile mode: create (overwrite=false) vs update (true).
   */
  async httpC2ProfileExists(name: string): Promise<boolean> {
    const list = await this.getHttpC2Profiles();
    return (list.configs ?? []).some((p: { Name: string }) => p.Name === name);
  }
  monitorListConfig() {
    return this.unary(this.client.monitorListConfig, Empty.create({}));
  }
  monitorStart() {
    return this.unary(this.client.monitorStart, Empty.create({}));
  }
  monitorStop() {
    return this.unary(this.client.monitorStop, Empty.create({}));
  }
  backdoor(req: DeepPartial<BackdoorReq>) {
    return this.unary(this.client.backdoor, BackdoorReq.fromPartial(req));
  }
  hijackDll(req: DeepPartial<DllHijackReq>) {
    return this.unary(this.client.hijackDll, DllHijackReq.fromPartial(req));
  }
  monitorAddConfig(req: DeepPartial<MonitoringProvider>) {
    return this.unary(this.client.monitorAddConfig, MonitoringProvider.fromPartial(req));
  }

  // --- More file ops ----------------------------------------------------
  chmod(req: DeepPartial<ChmodReq>) {
    return this.unary(this.client.chmod, ChmodReq.fromPartial(req));
  }
  chown(req: DeepPartial<ChownReq>) {
    return this.unary(this.client.chown, ChownReq.fromPartial(req));
  }
  chtimes(req: DeepPartial<ChtimesReq>) {
    return this.unary(this.client.chtimes, ChtimesReq.fromPartial(req));
  }
  cp(req: DeepPartial<CpReq>) {
    return this.unary(this.client.cp, CpReq.fromPartial(req));
  }
  grep(req: DeepPartial<GrepReq>) {
    return this.unary(this.client.grep, GrepReq.fromPartial(req));
  }
  mount(sessionId: string) {
    return this.unary(this.client.mount, MountReq.fromPartial({ Request: { SessionID: sessionId } }));
  }
  memfilesList(sessionId: string) {
    return this.unary(this.client.memfilesList, MemfilesListReq.fromPartial({ Request: { SessionID: sessionId } }));
  }
  memfilesAdd(sessionId: string) {
    return this.unary(this.client.memfilesAdd, MemfilesAddReq.fromPartial({ Request: { SessionID: sessionId } }));
  }
  memfilesRm(req: DeepPartial<MemfilesRmReq>) {
    return this.unary(this.client.memfilesRm, MemfilesRmReq.fromPartial(req));
  }

  // --- More execution ---------------------------------------------------
  executeWindows(req: DeepPartial<ExecuteWindowsReq>) {
    return this.unary(this.client.executeWindows, ExecuteWindowsReq.fromPartial(req));
  }
  task(req: DeepPartial<TaskReq>) {
    return this.unary(this.client.task, TaskReq.fromPartial(req));
  }
  msfRemote(req: DeepPartial<MSFRemoteReq>) {
    return this.unary(this.client.msfRemote, MSFRemoteReq.fromPartial(req));
  }

  // --- Beacon <-> session mode ------------------------------------------
  openSession(req: DeepPartial<OpenSession>) {
    return this.unary(this.client.openSession, OpenSession.fromPartial(req));
  }
  closeSession(sessionId: string) {
    return this.unary(this.client.closeSession, CloseSession.fromPartial({ Request: { SessionID: sessionId } }));
  }

  // --- Registry (Windows) -----------------------------------------------
  registryCreateKey(req: DeepPartial<RegistryCreateKeyReq>) {
    return this.unary(this.client.registryCreateKey, RegistryCreateKeyReq.fromPartial(req));
  }
  registryDeleteKey(req: DeepPartial<RegistryDeleteKeyReq>) {
    return this.unary(this.client.registryDeleteKey, RegistryDeleteKeyReq.fromPartial(req));
  }
  registryListSubKeys(req: DeepPartial<RegistrySubKeyListReq>) {
    return this.unary(this.client.registryListSubKeys, RegistrySubKeyListReq.fromPartial(req));
  }
  registryListValues(req: DeepPartial<RegistryListValuesReq>) {
    return this.unary(this.client.registryListValues, RegistryListValuesReq.fromPartial(req));
  }
  registryReadHive(req: DeepPartial<RegistryReadHiveReq>) {
    return this.unary(this.client.registryReadHive, RegistryReadHiveReq.fromPartial(req));
  }

  // --- Services (Windows) -----------------------------------------------
  startService(req: DeepPartial<StartServiceReq>) {
    return this.unary(this.client.startService, StartServiceReq.fromPartial(req));
  }
  startServiceByName(req: DeepPartial<StartServiceByNameReq>) {
    return this.unary(this.client.startServiceByName, StartServiceByNameReq.fromPartial(req));
  }
  stopService(req: DeepPartial<StopServiceReq>) {
    return this.unary(this.client.stopService, StopServiceReq.fromPartial(req));
  }
  removeService(req: DeepPartial<RemoveServiceReq>) {
    return this.unary(this.client.removeService, RemoveServiceReq.fromPartial(req));
  }
  serviceDetail(req: DeepPartial<ServiceDetailReq>) {
    return this.unary(this.client.serviceDetail, ServiceDetailReq.fromPartial(req));
  }

  // --- Pivots -----------------------------------------------------------
  pivotStartListener(req: DeepPartial<PivotStartListenerReq>) {
    return this.unary(this.client.pivotStartListener, PivotStartListenerReq.fromPartial(req));
  }
  pivotStopListener(req: DeepPartial<PivotStopListenerReq>) {
    return this.unary(this.client.pivotStopListener, PivotStopListenerReq.fromPartial(req));
  }
  pivotSessionListeners(sessionId: string) {
    return this.unary(
      this.client.pivotSessionListeners,
      PivotListenersReq.fromPartial({ Request: { SessionID: sessionId } }),
    );
  }
  pivotGraph() {
    return this.unary(this.client.pivotGraph, Empty.create({}));
  }

  // --- WireGuard --------------------------------------------------------
  startWgListener(req: DeepPartial<WGListenerReq>) {
    return this.unary(this.client.startWgListener, WGListenerReq.fromPartial(req));
  }
  wgStartPortForward(req: DeepPartial<WGPortForwardStartReq>) {
    return this.unary(this.client.wgStartPortForward, WGPortForwardStartReq.fromPartial(req));
  }
  wgStartSocks(req: DeepPartial<WGSocksStartReq>) {
    return this.unary(this.client.wgStartSocks, WGSocksStartReq.fromPartial(req));
  }
  wgStopPortForward(req: DeepPartial<WGPortForwardStopReq>) {
    return this.unary(this.client.wgStopPortForward, WGPortForwardStopReq.fromPartial(req));
  }
  wgStopSocks(req: DeepPartial<WGSocksStopReq>) {
    return this.unary(this.client.wgStopSocks, WGSocksStopReq.fromPartial(req));
  }
  wgListForwarders(sessionId: string) {
    return this.unary(this.client.wgListForwarders, WGTCPForwardersReq.fromPartial({ Request: { SessionID: sessionId } }));
  }
  wgListSocksServers(sessionId: string) {
    return this.unary(this.client.wgListSocksServers, WGSocksServersReq.fromPartial({ Request: { SessionID: sessionId } }));
  }

  // --- Stager listener --------------------------------------------------
  startTcpStagerListener(req: DeepPartial<StagerListenerReq>) {
    return this.unary(this.client.startTcpStagerListener, StagerListenerReq.fromPartial(req));
  }

  // --- Advanced: read-only listings -------------------------------------
  getCertificateInfo(req: DeepPartial<CertificatesReq>) {
    return this.unary(this.client.getCertificateInfo, CertificatesReq.fromPartial(req));
  }
  crackstations() {
    return this.unary(this.client.crackstations, Empty.create({}));
  }
  builders() {
    return this.unary(this.client.builders, Empty.create({}));
  }
  listWasmExtensions(sessionId: string) {
    return this.unary(
      this.client.listWasmExtensions,
      ListExtensionsReq.fromPartial({ Request: { SessionID: sessionId } }),
    );
  }
  trafficEncoderMap() {
    return this.unary(this.client.trafficEncoderMap, Empty.create({}));
  }

  // --- Tunnels (interactive shell) --------------------------------------

  /** Allocate a tunnel id bound to a session. */
  createTunnel(sessionId: string): Promise<Tunnel> {
    return this.unary(this.client.createTunnel, Tunnel.fromPartial({ SessionID: sessionId }));
  }

  /** Open the bidirectional tunnel data stream. */
  openTunnelData(): grpc.ClientDuplexStream<TunnelData, TunnelData> {
    return this.client.tunnelData();
  }

  /** Tear down a tunnel on the server. */
  closeTunnel(tunnelId: string, sessionId: string): Promise<unknown> {
    return this.unary(
      this.client.closeTunnel,
      Tunnel.fromPartial({ TunnelID: tunnelId, SessionID: sessionId }),
    );
  }

  /** Bind a shell to a tunnel (call after createTunnel + first TunnelData). */
  shell(req: DeepPartial<ShellReq>): Promise<Shell> {
    return this.unary(this.client.shell, ShellReq.fromPartial(req));
  }
}
