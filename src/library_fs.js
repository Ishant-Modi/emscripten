/**
 * @license
 * Copyright 2013 The Emscripten Authors
 * SPDX-License-Identifier: MIT
 */

mergeInto(LibraryManager.library, {
  $FS__deps: ['$randomFill', '$PATH', '$PATH_FS', '$TTY', '$MEMFS', '$asyncLoad',
    '$intArrayFromString',
    '$stringToUTF8Array',
    '$lengthBytesUTF8',
#if LibraryManager.has('library_idbfs.js')
    '$IDBFS',
#endif
#if LibraryManager.has('library_nodefs.js')
    '$NODEFS',
#endif
#if LibraryManager.has('library_workerfs.js')
    '$WORKERFS',
#endif
#if LibraryManager.has('library_noderawfs.js')
    '$NODERAWFS',
#endif
#if LibraryManager.has('library_proxyfs.js')
    '$PROXYFS',
#endif
#if ASSERTIONS
    '$ERRNO_MESSAGES', '$ERRNO_CODES',
#endif
#if ASSERTIONS && !MINIMAL_RUNTIME
    '$demangleAll',
#endif
    ],
  $FS__postset: function() {
    // TODO: do we need noFSInit?
    addAtInit(`
if (!Module["noFSInit"] && !FS.init.initialized)
  FS.init();
FS.ignorePermissions = false;
`)
    addAtExit('FS.quit();');
    // We must statically create FS.FSNode here so that it is created in a manner
    // that is visible to Closure compiler. That lets us use type annotations for
    // Closure to the "this" pointer in various node creation functions.
    return `
var FSNode = /** @constructor */ function(parent, name, mode, rdev) {
  if (!parent) {
    parent = this;  // root node sets parent to itself
  }
  this.parent = parent;
  this.mount = parent.mount;
  this.mounted = null;
  this.id = FS.nextInode++;
  this.name = name;
  this.mode = mode;
  this.node_ops = {};
  this.stream_ops = {};
  this.rdev = rdev;
};
var readMode = 292/*{{{ cDefs.S_IRUGO }}}*/ | 73/*{{{ cDefs.S_IXUGO }}}*/;
var writeMode = 146/*{{{ cDefs.S_IWUGO }}}*/;
Object.defineProperties(FSNode.prototype, {
 read: {
  get: /** @this{FSNode} */function() {
   return (this.mode & readMode) === readMode;
  },
  set: /** @this{FSNode} */function(val) {
   val ? this.mode |= readMode : this.mode &= ~readMode;
  }
 },
 write: {
  get: /** @this{FSNode} */function() {
   return (this.mode & writeMode) === writeMode;
  },
  set: /** @this{FSNode} */function(val) {
   val ? this.mode |= writeMode : this.mode &= ~writeMode;
  }
 },
 isFolder: {
  get: /** @this{FSNode} */function() {
   return FS.isDir(this.mode);
  }
 },
 isDevice: {
  get: /** @this{FSNode} */function() {
   return FS.isChrdev(this.mode);
  }
 }
});
FS.FSNode = FSNode;
FS.staticInit();` +
#if USE_CLOSURE_COMPILER
           // Declare variable for Closure, FS.createPreloadedFile() below calls Browser.handledByPreloadPlugin()
           '/**@suppress {duplicate, undefinedVars}*/var Browser;' +
#endif
           // Get module methods from settings
           '{{{ EXPORTED_RUNTIME_METHODS.filter(function(func) { return func.substr(0, 3) === 'FS_' }).map(function(func){return 'Module["' + func + '"] = FS.' + func.substr(3) + ";"}).reduce(function(str, func){return str + func;}, '') }}}';
  },
  $FS: {
    root: null,
    mounts: [],
    devices: {},
    streams: [],
    nextInode: 1,
    nameTable: null,
    currentPath: '/',
    initialized: false,
    // Whether we are currently ignoring permissions. Useful when preparing the
    // filesystem and creating files inside read-only folders.
    // This is set to false during `preInit`, allowing you to modify the
    // filesystem freely up until that point (e.g. during `preRun`).
    ignorePermissions: true,
#if FS_DEBUG
    trackingDelegate: {},
#endif
    ErrnoError: null, // set during init
    genericErrors: {},
    filesystems: null,
    syncFSRequests: 0, // we warn if there are multiple in flight at once

    //
    // paths
    //
    lookupPath: (path, opts = {}) => {
      path = PATH_FS.resolve(path);

      if (!path) return { path: '', node: null };

      var defaults = {
        follow_mount: true,
        recurse_count: 0
      };
      opts = Object.assign(defaults, opts)

      if (opts.recurse_count > 8) {  // max recursive lookup of 8
        throw new FS.ErrnoError({{{ cDefs.ELOOP }}});
      }

      // split the absolute path
      var parts = path.split('/').filter((p) => !!p);

      // start at the root
      var current = FS.root;
      var current_path = '/';

      for (var i = 0; i < parts.length; i++) {
        var islast = (i === parts.length-1);
        if (islast && opts.parent) {
          // stop resolving
          break;
        }

        current = FS.lookupNode(current, parts[i]);
        current_path = PATH.join2(current_path, parts[i]);

        // jump to the mount's root node if this is a mountpoint
        if (FS.isMountpoint(current)) {
          if (!islast || (islast && opts.follow_mount)) {
            current = current.mounted.root;
          }
        }

        // by default, lookupPath will not follow a symlink if it is the final path component.
        // setting opts.follow = true will override this behavior.
        if (!islast || opts.follow) {
          var count = 0;
          while (FS.isLink(current.mode)) {
            var link = FS.readlink(current_path);
            current_path = PATH_FS.resolve(PATH.dirname(current_path), link);

            var lookup = FS.lookupPath(current_path, { recurse_count: opts.recurse_count + 1 });
            current = lookup.node;

            if (count++ > 40) {  // limit max consecutive symlinks to 40 (SYMLOOP_MAX).
              throw new FS.ErrnoError({{{ cDefs.ELOOP }}});
            }
          }
        }
      }

      return { path: current_path, node: current };
    },
    getPath: (node) => {
      var path;
      while (true) {
        if (FS.isRoot(node)) {
          var mount = node.mount.mountpoint;
          if (!path) return mount;
          return mount[mount.length-1] !== '/' ? mount + '/' + path : mount + path;
        }
        path = path ? node.name + '/' + path : node.name;
        node = node.parent;
      }
    },

    //
    // nodes
    //
    hashName: (parentid, name) => {
      var hash = 0;

#if CASE_INSENSITIVE_FS
      name = name.toLowerCase();
#endif

      for (var i = 0; i < name.length; i++) {
        hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
      }
      return ((parentid + hash) >>> 0) % FS.nameTable.length;
    },
    hashAddNode: (node) => {
      var hash = FS.hashName(node.parent.id, node.name);
      node.name_next = FS.nameTable[hash];
      FS.nameTable[hash] = node;
    },
    hashRemoveNode: (node) => {
      var hash = FS.hashName(node.parent.id, node.name);
      if (FS.nameTable[hash] === node) {
        FS.nameTable[hash] = node.name_next;
      } else {
        var current = FS.nameTable[hash];
        while (current) {
          if (current.name_next === node) {
            current.name_next = node.name_next;
            break;
          }
          current = current.name_next;
        }
      }
    },
    lookupNode: (parent, name) => {
      var errCode = FS.mayLookup(parent);
      if (errCode) {
        throw new FS.ErrnoError(errCode, parent);
      }
      var hash = FS.hashName(parent.id, name);
#if CASE_INSENSITIVE_FS
      name = name.toLowerCase();
#endif
      for (var node = FS.nameTable[hash]; node; node = node.name_next) {
        var nodeName = node.name;
#if CASE_INSENSITIVE_FS
        nodeName = nodeName.toLowerCase();
#endif
        if (node.parent.id === parent.id && nodeName === name) {
          return node;
        }
      }
      // if we failed to find it in the cache, call into the VFS
      return FS.lookup(parent, name);
    },
    createNode: (parent, name, mode, rdev) => {
#if ASSERTIONS
      assert(typeof parent == 'object')
#endif
      var node = new FS.FSNode(parent, name, mode, rdev);

      FS.hashAddNode(node);

      return node;
    },
    destroyNode: (node) => {
      FS.hashRemoveNode(node);
    },
    isRoot: (node) => {
      return node === node.parent;
    },
    isMountpoint: (node) => {
      return !!node.mounted;
    },
    isFile: (mode) => {
      return (mode & {{{ cDefs.S_IFMT }}}) === {{{ cDefs.S_IFREG }}};
    },
    isDir: (mode) => {
      return (mode & {{{ cDefs.S_IFMT }}}) === {{{ cDefs.S_IFDIR }}};
    },
    isLink: (mode) => {
      return (mode & {{{ cDefs.S_IFMT }}}) === {{{ cDefs.S_IFLNK }}};
    },
    isChrdev: (mode) => {
      return (mode & {{{ cDefs.S_IFMT }}}) === {{{ cDefs.S_IFCHR }}};
    },
    isBlkdev: (mode) => {
      return (mode & {{{ cDefs.S_IFMT }}}) === {{{ cDefs.S_IFBLK }}};
    },
    isFIFO: (mode) => {
      return (mode & {{{ cDefs.S_IFMT }}}) === {{{ cDefs.S_IFIFO }}};
    },
    isSocket: (mode) => {
      return (mode & {{{ cDefs.S_IFSOCK }}}) === {{{ cDefs.S_IFSOCK }}};
    },

    //
    // permissions
    //
    flagModes: {
      // Extra quotes used here on the keys to this object otherwise jsifier will
      // erase them in the process of reading and then writing the JS library
      // code.
      '"r"': {{{ cDefs.O_RDONLY }}},
      '"r+"': {{{ cDefs.O_RDWR }}},
      '"w"': {{{ cDefs.O_TRUNC }}} | {{{ cDefs.O_CREAT }}} | {{{ cDefs.O_WRONLY }}},
      '"w+"': {{{ cDefs.O_TRUNC }}} | {{{ cDefs.O_CREAT }}} | {{{ cDefs.O_RDWR }}},
      '"a"': {{{ cDefs.O_APPEND }}} | {{{ cDefs.O_CREAT }}} | {{{ cDefs.O_WRONLY }}},
      '"a+"': {{{ cDefs.O_APPEND }}} | {{{ cDefs.O_CREAT }}} | {{{ cDefs.O_RDWR }}},
    },
    // convert the 'r', 'r+', etc. to it's corresponding set of O_* flags
    modeStringToFlags: (str) => {
      var flags = FS.flagModes[str];
      if (typeof flags == 'undefined') {
        throw new Error('Unknown file open mode: ' + str);
      }
      return flags;
    },
    // convert O_* bitmask to a string for nodePermissions
    flagsToPermissionString: (flag) => {
      var perms = ['r', 'w', 'rw'][flag & 3];
      if ((flag & {{{ cDefs.O_TRUNC }}})) {
        perms += 'w';
      }
      return perms;
    },
    nodePermissions: (node, perms) => {
      if (FS.ignorePermissions) {
        return 0;
      }
      // return 0 if any user, group or owner bits are set.
      if (perms.includes('r') && !(node.mode & {{{ cDefs.S_IRUGO }}})) {
        return {{{ cDefs.EACCES }}};
      } else if (perms.includes('w') && !(node.mode & {{{ cDefs.S_IWUGO }}})) {
        return {{{ cDefs.EACCES }}};
      } else if (perms.includes('x') && !(node.mode & {{{ cDefs.S_IXUGO }}})) {
        return {{{ cDefs.EACCES }}};
      }
      return 0;
    },
    mayLookup: (dir) => {
      var errCode = FS.nodePermissions(dir, 'x');
      if (errCode) return errCode;
      if (!dir.node_ops.lookup) return {{{ cDefs.EACCES }}};
      return 0;
    },
    mayCreate: (dir, name) => {
      try {
        var node = FS.lookupNode(dir, name);
        return {{{ cDefs.EEXIST }}};
      } catch (e) {
      }
      return FS.nodePermissions(dir, 'wx');
    },
    mayDelete: (dir, name, isdir) => {
      var node;
      try {
        node = FS.lookupNode(dir, name);
      } catch (e) {
        return e.errno;
      }
      var errCode = FS.nodePermissions(dir, 'wx');
      if (errCode) {
        return errCode;
      }
      if (isdir) {
        if (!FS.isDir(node.mode)) {
          return {{{ cDefs.ENOTDIR }}};
        }
        if (FS.isRoot(node) || FS.getPath(node) === FS.cwd()) {
          return {{{ cDefs.EBUSY }}};
        }
      } else {
        if (FS.isDir(node.mode)) {
          return {{{ cDefs.EISDIR }}};
        }
      }
      return 0;
    },
    mayOpen: (node, flags) => {
      if (!node) {
        return {{{ cDefs.ENOENT }}};
      }
      if (FS.isLink(node.mode)) {
        return {{{ cDefs.ELOOP }}};
      } else if (FS.isDir(node.mode)) {
        if (FS.flagsToPermissionString(flags) !== 'r' || // opening for write
            (flags & {{{ cDefs.O_TRUNC }}})) { // TODO: check for O_SEARCH? (== search for dir only)
          return {{{ cDefs.EISDIR }}};
        }
      }
      return FS.nodePermissions(node, FS.flagsToPermissionString(flags));
    },

    //
    // streams
    //
    MAX_OPEN_FDS: 4096,
    nextfd: (fd_start = 0, fd_end = FS.MAX_OPEN_FDS) => {
      for (var fd = fd_start; fd <= fd_end; fd++) {
        if (!FS.streams[fd]) {
          return fd;
        }
      }
      throw new FS.ErrnoError({{{ cDefs.EMFILE }}});
    },
    getStream: (fd) => FS.streams[fd],
    // TODO parameterize this function such that a stream
    // object isn't directly passed in. not possible until
    // SOCKFS is completed.
    createStream: (stream, fd_start, fd_end) => {
      if (!FS.FSStream) {
        FS.FSStream = /** @constructor */ function() {
          this.shared = { };
        };
        FS.FSStream.prototype = {};
        Object.defineProperties(FS.FSStream.prototype, {
          object: {
            /** @this {FS.FSStream} */
            get: function() { return this.node; },
            /** @this {FS.FSStream} */
            set: function(val) { this.node = val; }
          },
          isRead: {
            /** @this {FS.FSStream} */
            get: function() { return (this.flags & {{{ cDefs.O_ACCMODE }}}) !== {{{ cDefs.O_WRONLY }}}; }
          },
          isWrite: {
            /** @this {FS.FSStream} */
            get: function() { return (this.flags & {{{ cDefs.O_ACCMODE }}}) !== {{{ cDefs.O_RDONLY }}}; }
          },
          isAppend: {
            /** @this {FS.FSStream} */
            get: function() { return (this.flags & {{{ cDefs.O_APPEND }}}); }
          },
          flags: {
            /** @this {FS.FSStream} */
            get: function() { return this.shared.flags; },
            /** @this {FS.FSStream} */
            set: function(val) { this.shared.flags = val; },
          },
          position : {
            /** @this {FS.FSStream} */
            get: function() { return this.shared.position; },
            /** @this {FS.FSStream} */
            set: function(val) { this.shared.position = val; },
          },
        });
      }
      // clone it, so we can return an instance of FSStream
      stream = Object.assign(new FS.FSStream(), stream);
      var fd = FS.nextfd(fd_start, fd_end);
      stream.fd = fd;
      FS.streams[fd] = stream;
      return stream;
    },
    closeStream: (fd) => {
      FS.streams[fd] = null;
    },

    //
    // devices
    //
    // each character device consists of a device id + stream operations.
    // when a character device node is created (e.g. /dev/stdin) it is
    // assigned a device id that lets us map back to the actual device.
    // by default, each character device stream (e.g. _stdin) uses chrdev_stream_ops.
    // however, once opened, the stream's operations are overridden with
    // the operations of the device its underlying node maps back to.
    chrdev_stream_ops: {
      open: (stream) => {
        var device = FS.getDevice(stream.node.rdev);
        // override node's stream ops with the device's
        stream.stream_ops = device.stream_ops;
        // forward the open call
        if (stream.stream_ops.open) {
          stream.stream_ops.open(stream);
        }
      },
      llseek: () => {
        throw new FS.ErrnoError({{{ cDefs.ESPIPE }}});
      }
    },
    major: (dev) => ((dev) >> 8),
    minor: (dev) => ((dev) & 0xff),
    makedev: (ma, mi) => ((ma) << 8 | (mi)),
    registerDevice: (dev, ops) => {
      FS.devices[dev] = { stream_ops: ops };
    },
    getDevice: (dev) => FS.devices[dev],

    //
    // core
    //
    getMounts: (mount) => {
      var mounts = [];
      var check = [mount];

      while (check.length) {
        var m = check.pop();

        mounts.push(m);

        check.push.apply(check, m.mounts);
      }

      return mounts;
    },
    syncfs: (populate, callback) => {
      if (typeof populate == 'function') {
        callback = populate;
        populate = false;
      }

      FS.syncFSRequests++;

      if (FS.syncFSRequests > 1) {
        err('warning: ' + FS.syncFSRequests + ' FS.syncfs operations in flight at once, probably just doing extra work');
      }

      var mounts = FS.getMounts(FS.root.mount);
      var completed = 0;

      function doCallback(errCode) {
#if ASSERTIONS
        assert(FS.syncFSRequests > 0);
#endif
        FS.syncFSRequests--;
        return callback(errCode);
      }

      function done(errCode) {
        if (errCode) {
          if (!done.errored) {
            done.errored = true;
            return doCallback(errCode);
          }
          return;
        }
        if (++completed >= mounts.length) {
          doCallback(null);
        }
      };

      // sync all mounts
      mounts.forEach((mount) => {
        if (!mount.type.syncfs) {
          return done(null);
        }
        mount.type.syncfs(mount, populate, done);
      });
    },
    mount: (type, opts, mountpoint) => {
#if ASSERTIONS
      if (typeof type == 'string') {
        // The filesystem was not included, and instead we have an error
        // message stored in the variable.
        throw type;
      }
#endif
      var root = mountpoint === '/';
      var pseudo = !mountpoint;
      var node;

      if (root && FS.root) {
        throw new FS.ErrnoError({{{ cDefs.EBUSY }}});
      } else if (!root && !pseudo) {
        var lookup = FS.lookupPath(mountpoint, { follow_mount: false });

        mountpoint = lookup.path;  // use the absolute path
        node = lookup.node;

        if (FS.isMountpoint(node)) {
          throw new FS.ErrnoError({{{ cDefs.EBUSY }}});
        }

        if (!FS.isDir(node.mode)) {
          throw new FS.ErrnoError({{{ cDefs.ENOTDIR }}});
        }
      }

      var mount = {
        type: type,
        opts: opts,
        mountpoint: mountpoint,
        mounts: []
      };

      // create a root node for the fs
      var mountRoot = type.mount(mount);
      mountRoot.mount = mount;
      mount.root = mountRoot;

      if (root) {
        FS.root = mountRoot;
      } else if (node) {
        // set as a mountpoint
        node.mounted = mount;

        // add the new mount to the current mount's children
        if (node.mount) {
          node.mount.mounts.push(mount);
        }
      }

      return mountRoot;
    },
    unmount: (mountpoint) => {
      var lookup = FS.lookupPath(mountpoint, { follow_mount: false });

      if (!FS.isMountpoint(lookup.node)) {
        throw new FS.ErrnoError({{{ cDefs.EINVAL }}});
      }

      // destroy the nodes for this mount, and all its child mounts
      var node = lookup.node;
      var mount = node.mounted;
      var mounts = FS.getMounts(mount);

      Object.keys(FS.nameTable).forEach((hash) => {
        var current = FS.nameTable[hash];

        while (current) {
          var next = current.name_next;

          if (mounts.includes(current.mount)) {
            FS.destroyNode(current);
          }

          current = next;
        }
      });

      // no longer a mountpoint
      node.mounted = null;

      // remove this mount from the child mounts
      var idx = node.mount.mounts.indexOf(mount);
#if ASSERTIONS
      assert(idx !== -1);
#endif
      node.mount.mounts.splice(idx, 1);
    },
    lookup: (parent, name) => {
      return parent.node_ops.lookup(parent, name);
    },
    // generic function for all node creation
    mknod: (path, mode, dev) => {
      var lookup = FS.lookupPath(path, { parent: true });
      var parent = lookup.node;
      var name = PATH.basename(path);
      if (!name || name === '.' || name === '..') {
        throw new FS.ErrnoError({{{ cDefs.EINVAL }}});
      }
      var errCode = FS.mayCreate(parent, name);
      if (errCode) {
        throw new FS.ErrnoError(errCode);
      }
      if (!parent.node_ops.mknod) {
        throw new FS.ErrnoError({{{ cDefs.EPERM }}});
      }
      return parent.node_ops.mknod(parent, name, mode, dev);
    },
    // helpers to create specific types of nodes
    create: (path, mode) => {
      mode = mode !== undefined ? mode : 438 /* 0666 */;
      mode &= {{{ cDefs.S_IALLUGO }}};
      mode |= {{{ cDefs.S_IFREG }}};
      return FS.mknod(path, mode, 0);
    },
    mkdir: (path, mode) => {
      mode = mode !== undefined ? mode : 511 /* 0777 */;
      mode &= {{{ cDefs.S_IRWXUGO }}} | {{{ cDefs.S_ISVTX }}};
      mode |= {{{ cDefs.S_IFDIR }}};
#if FS_DEBUG
      if (FS.trackingDelegate['onMakeDirectory']) {
        FS.trackingDelegate['onMakeDirectory'](path, mode);
      }
#endif
      return FS.mknod(path, mode, 0);
    },
    // Creates a whole directory tree chain if it doesn't yet exist
    mkdirTree: (path, mode) => {
      var dirs = path.split('/');
      var d = '';
      for (var i = 0; i < dirs.length; ++i) {
        if (!dirs[i]) continue;
        d += '/' + dirs[i];
        try {
          FS.mkdir(d, mode);
        } catch(e) {
          if (e.errno != {{{ cDefs.EEXIST }}}) throw e;
        }
      }
    },
    mkdev: (path, mode, dev) => {
      if (typeof dev == 'undefined') {
        dev = mode;
        mode = 438 /* 0666 */;
      }
      mode |= {{{ cDefs.S_IFCHR }}};
      return FS.mknod(path, mode, dev);
    },
    symlink: (oldpath, newpath) => {
      if (!PATH_FS.resolve(oldpath)) {
        throw new FS.ErrnoError({{{ cDefs.ENOENT }}});
      }
      var lookup = FS.lookupPath(newpath, { parent: true });
      var parent = lookup.node;
      if (!parent) {
        throw new FS.ErrnoError({{{ cDefs.ENOENT }}});
      }
      var newname = PATH.basename(newpath);
      var errCode = FS.mayCreate(parent, newname);
      if (errCode) {
        throw new FS.ErrnoError(errCode);
      }
      if (!parent.node_ops.symlink) {
        throw new FS.ErrnoError({{{ cDefs.EPERM }}});
      }
#if FS_DEBUG
      if (FS.trackingDelegate['onMakeSymlink']) {
        FS.trackingDelegate['onMakeSymlink'](oldpath, newpath);
      }
#endif
      return parent.node_ops.symlink(parent, newname, oldpath);
    },
    rename: (old_path, new_path) => {
      var old_dirname = PATH.dirname(old_path);
      var new_dirname = PATH.dirname(new_path);
      var old_name = PATH.basename(old_path);
      var new_name = PATH.basename(new_path);
      // parents must exist
      var lookup, old_dir, new_dir;

      // let the errors from non existant directories percolate up
      lookup = FS.lookupPath(old_path, { parent: true });
      old_dir = lookup.node;
      lookup = FS.lookupPath(new_path, { parent: true });
      new_dir = lookup.node;

      if (!old_dir || !new_dir) throw new FS.ErrnoError({{{ cDefs.ENOENT }}});
      // need to be part of the same mount
      if (old_dir.mount !== new_dir.mount) {
        throw new FS.ErrnoError({{{ cDefs.EXDEV }}});
      }
      // source must exist
      var old_node = FS.lookupNode(old_dir, old_name);
      // old path should not be an ancestor of the new path
      var relative = PATH_FS.relative(old_path, new_dirname);
      if (relative.charAt(0) !== '.') {
        throw new FS.ErrnoError({{{ cDefs.EINVAL }}});
      }
      // new path should not be an ancestor of the old path
      relative = PATH_FS.relative(new_path, old_dirname);
      if (relative.charAt(0) !== '.') {
        throw new FS.ErrnoError({{{ cDefs.ENOTEMPTY }}});
      }
      // see if the new path already exists
      var new_node;
      try {
        new_node = FS.lookupNode(new_dir, new_name);
      } catch (e) {
        // not fatal
      }
      // early out if nothing needs to change
      if (old_node === new_node) {
        return;
      }
      // we'll need to delete the old entry
      var isdir = FS.isDir(old_node.mode);
      var errCode = FS.mayDelete(old_dir, old_name, isdir);
      if (errCode) {
        throw new FS.ErrnoError(errCode);
      }
      // need delete permissions if we'll be overwriting.
      // need create permissions if new doesn't already exist.
      errCode = new_node ?
        FS.mayDelete(new_dir, new_name, isdir) :
        FS.mayCreate(new_dir, new_name);
      if (errCode) {
        throw new FS.ErrnoError(errCode);
      }
      if (!old_dir.node_ops.rename) {
        throw new FS.ErrnoError({{{ cDefs.EPERM }}});
      }
      if (FS.isMountpoint(old_node) || (new_node && FS.isMountpoint(new_node))) {
        throw new FS.ErrnoError({{{ cDefs.EBUSY }}});
      }
      // if we are going to change the parent, check write permissions
      if (new_dir !== old_dir) {
        errCode = FS.nodePermissions(old_dir, 'w');
        if (errCode) {
          throw new FS.ErrnoError(errCode);
        }
      }
#if FS_DEBUG
      if (FS.trackingDelegate['willMovePath']) {
        FS.trackingDelegate['willMovePath'](old_path, new_path);
      }
#endif
      // remove the node from the lookup hash
      FS.hashRemoveNode(old_node);
      // do the underlying fs rename
      try {
        old_dir.node_ops.rename(old_node, new_dir, new_name);
      } catch (e) {
        throw e;
      } finally {
        // add the node back to the hash (in case node_ops.rename
        // changed its name)
        FS.hashAddNode(old_node);
      }
#if FS_DEBUG
      if (FS.trackingDelegate['onMovePath']) {
        FS.trackingDelegate['onMovePath'](old_path, new_path);
      }
#endif
    },
    rmdir: (path) => {
      var lookup = FS.lookupPath(path, { parent: true });
      var parent = lookup.node;
      var name = PATH.basename(path);
      var node = FS.lookupNode(parent, name);
      var errCode = FS.mayDelete(parent, name, true);
      if (errCode) {
        throw new FS.ErrnoError(errCode);
      }
      if (!parent.node_ops.rmdir) {
        throw new FS.ErrnoError({{{ cDefs.EPERM }}});
      }
      if (FS.isMountpoint(node)) {
        throw new FS.ErrnoError({{{ cDefs.EBUSY }}});
      }
#if FS_DEBUG
      if (FS.trackingDelegate['willDeletePath']) {
        FS.trackingDelegate['willDeletePath'](path);
      }
#endif
      parent.node_ops.rmdir(parent, name);
      FS.destroyNode(node);
#if FS_DEBUG
      if (FS.trackingDelegate['onDeletePath']) {
        FS.trackingDelegate['onDeletePath'](path);
      }
#endif
    },
    readdir: (path) => {
      var lookup = FS.lookupPath(path, { follow: true });
      var node = lookup.node;
      if (!node.node_ops.readdir) {
        throw new FS.ErrnoError({{{ cDefs.ENOTDIR }}});
      }
      return node.node_ops.readdir(node);
    },
    unlink: (path) => {
      var lookup = FS.lookupPath(path, { parent: true });
      var parent = lookup.node;
      if (!parent) {
        throw new FS.ErrnoError({{{ cDefs.ENOENT }}});
      }
      var name = PATH.basename(path);
      var node = FS.lookupNode(parent, name);
      var errCode = FS.mayDelete(parent, name, false);
      if (errCode) {
        // According to POSIX, we should map EISDIR to EPERM, but
        // we instead do what Linux does (and we must, as we use
        // the musl linux libc).
        throw new FS.ErrnoError(errCode);
      }
      if (!parent.node_ops.unlink) {
        throw new FS.ErrnoError({{{ cDefs.EPERM }}});
      }
      if (FS.isMountpoint(node)) {
        throw new FS.ErrnoError({{{ cDefs.EBUSY }}});
      }
#if FS_DEBUG
      if (FS.trackingDelegate['willDeletePath']) {
        FS.trackingDelegate['willDeletePath'](path);
      }
#endif
      parent.node_ops.unlink(parent, name);
      FS.destroyNode(node);
#if FS_DEBUG
      if (FS.trackingDelegate['onDeletePath']) {
        FS.trackingDelegate['onDeletePath'](path);
      }
#endif
    },
    readlink: (path) => {
      var lookup = FS.lookupPath(path);
      var link = lookup.node;
      if (!link) {
        throw new FS.ErrnoError({{{ cDefs.ENOENT }}});
      }
      if (!link.node_ops.readlink) {
        throw new FS.ErrnoError({{{ cDefs.EINVAL }}});
      }
      return PATH_FS.resolve(FS.getPath(link.parent), link.node_ops.readlink(link));
    },
    stat: (path, dontFollow) => {
      var lookup = FS.lookupPath(path, { follow: !dontFollow });
      var node = lookup.node;
      if (!node) {
        throw new FS.ErrnoError({{{ cDefs.ENOENT }}});
      }
      if (!node.node_ops.getattr) {
        throw new FS.ErrnoError({{{ cDefs.EPERM }}});
      }
      return node.node_ops.getattr(node);
    },
    lstat: (path) => {
      return FS.stat(path, true);
    },
    chmod: (path, mode, dontFollow) => {
      var node;
      if (typeof path == 'string') {
        var lookup = FS.lookupPath(path, { follow: !dontFollow });
        node = lookup.node;
      } else {
        node = path;
      }
      if (!node.node_ops.setattr) {
        throw new FS.ErrnoError({{{ cDefs.EPERM }}});
      }
      node.node_ops.setattr(node, {
        mode: (mode & {{{ cDefs.S_IALLUGO }}}) | (node.mode & ~{{{ cDefs.S_IALLUGO }}}),
        timestamp: Date.now()
      });
    },
    lchmod: (path, mode) => {
      FS.chmod(path, mode, true);
    },
    fchmod: (fd, mode) => {
      var stream = FS.getStream(fd);
      if (!stream) {
        throw new FS.ErrnoError({{{ cDefs.EBADF }}});
      }
      FS.chmod(stream.node, mode);
    },
    chown: (path, uid, gid, dontFollow) => {
      var node;
      if (typeof path == 'string') {
        var lookup = FS.lookupPath(path, { follow: !dontFollow });
        node = lookup.node;
      } else {
        node = path;
      }
      if (!node.node_ops.setattr) {
        throw new FS.ErrnoError({{{ cDefs.EPERM }}});
      }
      node.node_ops.setattr(node, {
        timestamp: Date.now()
        // we ignore the uid / gid for now
      });
    },
    lchown: (path, uid, gid) => {
      FS.chown(path, uid, gid, true);
    },
    fchown: (fd, uid, gid) => {
      var stream = FS.getStream(fd);
      if (!stream) {
        throw new FS.ErrnoError({{{ cDefs.EBADF }}});
      }
      FS.chown(stream.node, uid, gid);
    },
    truncate: (path, len) => {
      if (len < 0) {
        throw new FS.ErrnoError({{{ cDefs.EINVAL }}});
      }
      var node;
      if (typeof path == 'string') {
        var lookup = FS.lookupPath(path, { follow: true });
        node = lookup.node;
      } else {
        node = path;
      }
      if (!node.node_ops.setattr) {
        throw new FS.ErrnoError({{{ cDefs.EPERM }}});
      }
      if (FS.isDir(node.mode)) {
        throw new FS.ErrnoError({{{ cDefs.EISDIR }}});
      }
      if (!FS.isFile(node.mode)) {
        throw new FS.ErrnoError({{{ cDefs.EINVAL }}});
      }
      var errCode = FS.nodePermissions(node, 'w');
      if (errCode) {
        throw new FS.ErrnoError(errCode);
      }
      node.node_ops.setattr(node, {
        size: len,
        timestamp: Date.now()
      });
    },
    ftruncate: (fd, len) => {
      var stream = FS.getStream(fd);
      if (!stream) {
        throw new FS.ErrnoError({{{ cDefs.EBADF }}});
      }
      if ((stream.flags & {{{ cDefs.O_ACCMODE }}}) === {{{ cDefs.O_RDONLY}}}) {
        throw new FS.ErrnoError({{{ cDefs.EINVAL }}});
      }
      FS.truncate(stream.node, len);
    },
    utime: (path, atime, mtime) => {
      var lookup = FS.lookupPath(path, { follow: true });
      var node = lookup.node;
      node.node_ops.setattr(node, {
        timestamp: Math.max(atime, mtime)
      });
    },
    open: (path, flags, mode) => {
      if (path === "") {
        throw new FS.ErrnoError({{{ cDefs.ENOENT }}});
      }
      flags = typeof flags == 'string' ? FS.modeStringToFlags(flags) : flags;
      mode = typeof mode == 'undefined' ? 438 /* 0666 */ : mode;
      if ((flags & {{{ cDefs.O_CREAT }}})) {
        mode = (mode & {{{ cDefs.S_IALLUGO }}}) | {{{ cDefs.S_IFREG }}};
      } else {
        mode = 0;
      }
      var node;
      if (typeof path == 'object') {
        node = path;
      } else {
        path = PATH.normalize(path);
        try {
          var lookup = FS.lookupPath(path, {
            follow: !(flags & {{{ cDefs.O_NOFOLLOW }}})
          });
          node = lookup.node;
        } catch (e) {
          // ignore
        }
      }
      // perhaps we need to create the node
      var created = false;
      if ((flags & {{{ cDefs.O_CREAT }}})) {
        if (node) {
          // if O_CREAT and O_EXCL are set, error out if the node already exists
          if ((flags & {{{ cDefs.O_EXCL }}})) {
            throw new FS.ErrnoError({{{ cDefs.EEXIST }}});
          }
        } else {
          // node doesn't exist, try to create it
          node = FS.mknod(path, mode, 0);
          created = true;
        }
      }
      if (!node) {
        throw new FS.ErrnoError({{{ cDefs.ENOENT }}});
      }
      // can't truncate a device
      if (FS.isChrdev(node.mode)) {
        flags &= ~{{{ cDefs.O_TRUNC }}};
      }
      // if asked only for a directory, then this must be one
      if ((flags & {{{ cDefs.O_DIRECTORY }}}) && !FS.isDir(node.mode)) {
        throw new FS.ErrnoError({{{ cDefs.ENOTDIR }}});
      }
      // check permissions, if this is not a file we just created now (it is ok to
      // create and write to a file with read-only permissions; it is read-only
      // for later use)
      if (!created) {
        var errCode = FS.mayOpen(node, flags);
        if (errCode) {
          throw new FS.ErrnoError(errCode);
        }
      }
      // do truncation if necessary
      if ((flags & {{{ cDefs.O_TRUNC}}}) && !created) {
        FS.truncate(node, 0);
      }
#if FS_DEBUG
      var trackingFlags = flags
#endif
      // we've already handled these, don't pass down to the underlying vfs
      flags &= ~({{{ cDefs.O_EXCL }}} | {{{ cDefs.O_TRUNC }}} | {{{ cDefs.O_NOFOLLOW }}});

      // register the stream with the filesystem
      var stream = FS.createStream({
        node: node,
        path: FS.getPath(node),  // we want the absolute path to the node
        flags: flags,
        seekable: true,
        position: 0,
        stream_ops: node.stream_ops,
        // used by the file family libc calls (fopen, fwrite, ferror, etc.)
        ungotten: [],
        error: false
      });
      // call the new stream's open function
      if (stream.stream_ops.open) {
        stream.stream_ops.open(stream);
      }
      if (Module['logReadFiles'] && !(flags & {{{ cDefs.O_WRONLY}}})) {
        if (!FS.readFiles) FS.readFiles = {};
        if (!(path in FS.readFiles)) {
          FS.readFiles[path] = 1;
#if FS_DEBUG
          dbg("FS.trackingDelegate error on read file: " + path);
#endif
        }
      }
#if FS_DEBUG
      if (FS.trackingDelegate['onOpenFile']) {
        FS.trackingDelegate['onOpenFile'](path, trackingFlags);
      }
#endif
      return stream;
    },
    close: (stream) => {
      if (FS.isClosed(stream)) {
        throw new FS.ErrnoError({{{ cDefs.EBADF }}});
      }
      if (stream.getdents) stream.getdents = null; // free readdir state
      try {
        if (stream.stream_ops.close) {
          stream.stream_ops.close(stream);
        }
      } catch (e) {
        throw e;
      } finally {
        FS.closeStream(stream.fd);
      }
      stream.fd = null;
#if FS_DEBUG
      if (stream.path && FS.trackingDelegate['onCloseFile']) {
        FS.trackingDelegate['onCloseFile'](stream.path);
      }
#endif
    },
    isClosed: (stream) => {
      return stream.fd === null;
    },
    llseek: (stream, offset, whence) => {
      if (FS.isClosed(stream)) {
        throw new FS.ErrnoError({{{ cDefs.EBADF }}});
      }
      if (!stream.seekable || !stream.stream_ops.llseek) {
        throw new FS.ErrnoError({{{ cDefs.ESPIPE }}});
      }
      if (whence != {{{ cDefs.SEEK_SET }}} && whence != {{{ cDefs.SEEK_CUR }}} && whence != {{{ cDefs.SEEK_END }}}) {
        throw new FS.ErrnoError({{{ cDefs.EINVAL }}});
      }
      stream.position = stream.stream_ops.llseek(stream, offset, whence);
      stream.ungotten = [];
#if FS_DEBUG
      if (stream.path && FS.trackingDelegate['onSeekFile']) {
        FS.trackingDelegate['onSeekFile'](stream.path, stream.position, whence);
      }
#endif
      return stream.position;
    },
    read: (stream, buffer, offset, length, position) => {
#if CAN_ADDRESS_2GB
      offset >>>= 0;
#endif
      if (length < 0 || position < 0) {
        throw new FS.ErrnoError({{{ cDefs.EINVAL }}});
      }
      if (FS.isClosed(stream)) {
        throw new FS.ErrnoError({{{ cDefs.EBADF }}});
      }
      if ((stream.flags & {{{ cDefs.O_ACCMODE }}}) === {{{ cDefs.O_WRONLY}}}) {
        throw new FS.ErrnoError({{{ cDefs.EBADF }}});
      }
      if (FS.isDir(stream.node.mode)) {
        throw new FS.ErrnoError({{{ cDefs.EISDIR }}});
      }
      if (!stream.stream_ops.read) {
        throw new FS.ErrnoError({{{ cDefs.EINVAL }}});
      }
      var seeking = typeof position != 'undefined';
      if (!seeking) {
        position = stream.position;
      } else if (!stream.seekable) {
        throw new FS.ErrnoError({{{ cDefs.ESPIPE }}});
      }
      var bytesRead = stream.stream_ops.read(stream, buffer, offset, length, position);
      if (!seeking) stream.position += bytesRead;
#if FS_DEBUG
      if (stream.path && FS.trackingDelegate['onReadFile']) {
        FS.trackingDelegate['onReadFile'](stream.path, bytesRead);
      }
#endif
      return bytesRead;
    },
    write: (stream, buffer, offset, length, position, canOwn) => {
#if CAN_ADDRESS_2GB
      offset >>>= 0;
#endif
      if (length < 0 || position < 0) {
        throw new FS.ErrnoError({{{ cDefs.EINVAL }}});
      }
      if (FS.isClosed(stream)) {
        throw new FS.ErrnoError({{{ cDefs.EBADF }}});
      }
      if ((stream.flags & {{{ cDefs.O_ACCMODE }}}) === {{{ cDefs.O_RDONLY}}}) {
        throw new FS.ErrnoError({{{ cDefs.EBADF }}});
      }
      if (FS.isDir(stream.node.mode)) {
        throw new FS.ErrnoError({{{ cDefs.EISDIR }}});
      }
      if (!stream.stream_ops.write) {
        throw new FS.ErrnoError({{{ cDefs.EINVAL }}});
      }
      if (stream.seekable && stream.flags & {{{ cDefs.O_APPEND }}}) {
        // seek to the end before writing in append mode
        FS.llseek(stream, 0, {{{ cDefs.SEEK_END }}});
      }
      var seeking = typeof position != 'undefined';
      if (!seeking) {
        position = stream.position;
      } else if (!stream.seekable) {
        throw new FS.ErrnoError({{{ cDefs.ESPIPE }}});
      }
      var bytesWritten = stream.stream_ops.write(stream, buffer, offset, length, position, canOwn);
      if (!seeking) stream.position += bytesWritten;
#if FS_DEBUG
      if (stream.path && FS.trackingDelegate['onWriteToFile']) {
        FS.trackingDelegate['onWriteToFile'](stream.path, bytesWritten);
      }
#endif
      return bytesWritten;
    },
    allocate: (stream, offset, length) => {
      if (FS.isClosed(stream)) {
        throw new FS.ErrnoError({{{ cDefs.EBADF }}});
      }
      if (offset < 0 || length <= 0) {
        throw new FS.ErrnoError({{{ cDefs.EINVAL }}});
      }
      if ((stream.flags & {{{ cDefs.O_ACCMODE }}}) === {{{ cDefs.O_RDONLY}}}) {
        throw new FS.ErrnoError({{{ cDefs.EBADF }}});
      }
      if (!FS.isFile(stream.node.mode) && !FS.isDir(stream.node.mode)) {
        throw new FS.ErrnoError({{{ cDefs.ENODEV }}});
      }
      if (!stream.stream_ops.allocate) {
        throw new FS.ErrnoError({{{ cDefs.EOPNOTSUPP }}});
      }
      stream.stream_ops.allocate(stream, offset, length);
    },
    mmap: (stream, length, position, prot, flags) => {
      // User requests writing to file (prot & PROT_WRITE != 0).
      // Checking if we have permissions to write to the file unless
      // MAP_PRIVATE flag is set. According to POSIX spec it is possible
      // to write to file opened in read-only mode with MAP_PRIVATE flag,
      // as all modifications will be visible only in the memory of
      // the current process.
      if ((prot & {{{ cDefs.PROT_WRITE }}}) !== 0
          && (flags & {{{ cDefs.MAP_PRIVATE}}}) === 0
          && (stream.flags & {{{ cDefs.O_ACCMODE }}}) !== {{{ cDefs.O_RDWR}}}) {
        throw new FS.ErrnoError({{{ cDefs.EACCES }}});
      }
      if ((stream.flags & {{{ cDefs.O_ACCMODE }}}) === {{{ cDefs.O_WRONLY}}}) {
        throw new FS.ErrnoError({{{ cDefs.EACCES }}});
      }
      if (!stream.stream_ops.mmap) {
        throw new FS.ErrnoError({{{ cDefs.ENODEV }}});
      }
      return stream.stream_ops.mmap(stream, length, position, prot, flags);
    },
    msync: (stream, buffer, offset, length, mmapFlags) => {
#if CAN_ADDRESS_2GB
      offset >>>= 0;
#endif
      if (!stream.stream_ops.msync) {
        return 0;
      }
      return stream.stream_ops.msync(stream, buffer, offset, length, mmapFlags);
    },
    munmap: (stream) => 0,
    ioctl: (stream, cmd, arg) => {
      if (!stream.stream_ops.ioctl) {
        throw new FS.ErrnoError({{{ cDefs.ENOTTY }}});
      }
      return stream.stream_ops.ioctl(stream, cmd, arg);
    },
    readFile: (path, opts = {}) => {
      opts.flags = opts.flags || {{{ cDefs.O_RDONLY }}};
      opts.encoding = opts.encoding || 'binary';
      if (opts.encoding !== 'utf8' && opts.encoding !== 'binary') {
        throw new Error('Invalid encoding type "' + opts.encoding + '"');
      }
      var ret;
      var stream = FS.open(path, opts.flags);
      var stat = FS.stat(path);
      var length = stat.size;
      var buf = new Uint8Array(length);
      FS.read(stream, buf, 0, length, 0);
      if (opts.encoding === 'utf8') {
        ret = UTF8ArrayToString(buf, 0);
      } else if (opts.encoding === 'binary') {
        ret = buf;
      }
      FS.close(stream);
      return ret;
    },
    writeFile: (path, data, opts = {}) => {
      opts.flags = opts.flags || {{{ cDefs.O_TRUNC | cDefs.O_CREAT | cDefs.O_WRONLY }}};
      var stream = FS.open(path, opts.flags, opts.mode);
      if (typeof data == 'string') {
        var buf = new Uint8Array(lengthBytesUTF8(data)+1);
        var actualNumBytes = stringToUTF8Array(data, buf, 0, buf.length);
        FS.write(stream, buf, 0, actualNumBytes, undefined, opts.canOwn);
      } else if (ArrayBuffer.isView(data)) {
        FS.write(stream, data, 0, data.byteLength, undefined, opts.canOwn);
      } else {
        throw new Error('Unsupported data type');
      }
      FS.close(stream);
    },

    //
    // module-level FS code
    //
    cwd: () => FS.currentPath,
    chdir: (path) => {
      var lookup = FS.lookupPath(path, { follow: true });
      if (lookup.node === null) {
        throw new FS.ErrnoError({{{ cDefs.ENOENT }}});
      }
      if (!FS.isDir(lookup.node.mode)) {
        throw new FS.ErrnoError({{{ cDefs.ENOTDIR }}});
      }
      var errCode = FS.nodePermissions(lookup.node, 'x');
      if (errCode) {
        throw new FS.ErrnoError(errCode);
      }
      FS.currentPath = lookup.path;
    },
    createDefaultDirectories: () => {
      FS.mkdir('/tmp');
      FS.mkdir('/home');
      FS.mkdir('/home/web_user');
    },
    createDefaultDevices: () => {
      // create /dev
      FS.mkdir('/dev');
      // setup /dev/null
      FS.registerDevice(FS.makedev(1, 3), {
        read: () => 0,
        write: (stream, buffer, offset, length, pos) => length,
      });
      FS.mkdev('/dev/null', FS.makedev(1, 3));
      // setup /dev/tty and /dev/tty1
      // stderr needs to print output using err() rather than out()
      // so we register a second tty just for it.
      TTY.register(FS.makedev(5, 0), TTY.default_tty_ops);
      TTY.register(FS.makedev(6, 0), TTY.default_tty1_ops);
      FS.mkdev('/dev/tty', FS.makedev(5, 0));
      FS.mkdev('/dev/tty1', FS.makedev(6, 0));
      // setup /dev/[u]random
      // use a buffer to avoid overhead of individual crypto calls per byte
      var randomBuffer = new Uint8Array(1024), randomLeft = 0;
      var randomByte = () => {
        if (randomLeft === 0) {
          randomLeft = randomFill(randomBuffer).byteLength;
        }
        return randomBuffer[--randomLeft];
      };
      FS.createDevice('/dev', 'random', randomByte);
      FS.createDevice('/dev', 'urandom', randomByte);
      // we're not going to emulate the actual shm device,
      // just create the tmp dirs that reside in it commonly
      FS.mkdir('/dev/shm');
      FS.mkdir('/dev/shm/tmp');
    },
    createSpecialDirectories: () => {
      // create /proc/self/fd which allows /proc/self/fd/6 => readlink gives the
      // name of the stream for fd 6 (see test_unistd_ttyname)
      FS.mkdir('/proc');
      var proc_self = FS.mkdir('/proc/self');
      FS.mkdir('/proc/self/fd');
      FS.mount({
        mount: () => {
          var node = FS.createNode(proc_self, 'fd', {{{ cDefs.S_IFDIR }}} | 511 /* 0777 */, {{{ cDefs.S_IXUGO }}});
          node.node_ops = {
            lookup: (parent, name) => {
              var fd = +name;
              var stream = FS.getStream(fd);
              if (!stream) throw new FS.ErrnoError({{{ cDefs.EBADF }}});
              var ret = {
                parent: null,
                mount: { mountpoint: 'fake' },
                node_ops: { readlink: () => stream.path },
              };
              ret.parent = ret; // make it look like a simple root node
              return ret;
            }
          };
          return node;
        }
      }, {}, '/proc/self/fd');
    },
    createStandardStreams: () => {
      // TODO deprecate the old functionality of a single
      // input / output callback and that utilizes FS.createDevice
      // and instead require a unique set of stream ops

      // by default, we symlink the standard streams to the
      // default tty devices. however, if the standard streams
      // have been overwritten we create a unique device for
      // them instead.
      if (Module['stdin']) {
        FS.createDevice('/dev', 'stdin', Module['stdin']);
      } else {
        FS.symlink('/dev/tty', '/dev/stdin');
      }
      if (Module['stdout']) {
        FS.createDevice('/dev', 'stdout', null, Module['stdout']);
      } else {
        FS.symlink('/dev/tty', '/dev/stdout');
      }
      if (Module['stderr']) {
        FS.createDevice('/dev', 'stderr', null, Module['stderr']);
      } else {
        FS.symlink('/dev/tty1', '/dev/stderr');
      }

      // open default streams for the stdin, stdout and stderr devices
      var stdin = FS.open('/dev/stdin', {{{ cDefs.O_RDONLY }}});
      var stdout = FS.open('/dev/stdout', {{{ cDefs.O_WRONLY }}});
      var stderr = FS.open('/dev/stderr', {{{ cDefs.O_WRONLY }}});
#if ASSERTIONS
      assert(stdin.fd === 0, 'invalid handle for stdin (' + stdin.fd + ')');
      assert(stdout.fd === 1, 'invalid handle for stdout (' + stdout.fd + ')');
      assert(stderr.fd === 2, 'invalid handle for stderr (' + stderr.fd + ')');
#endif
    },
    ensureErrnoError: () => {
      if (FS.ErrnoError) return;
      FS.ErrnoError = /** @this{Object} */ function ErrnoError(errno, node) {
        // We set the `name` property to be able to identify `FS.ErrnoError`
        // - the `name` is a standard ECMA-262 property of error objects. Kind of good to have it anyway.
        // - when using PROXYFS, an error can come from an underlying FS
        // as different FS objects have their own FS.ErrnoError each,
        // the test `err instanceof FS.ErrnoError` won't detect an error coming from another filesystem, causing bugs.
        // we'll use the reliable test `err.name == "ErrnoError"` instead
        this.name = 'ErrnoError';
        this.node = node;
        this.setErrno = /** @this{Object} */ function(errno) {
          this.errno = errno;
#if ASSERTIONS
          for (var key in ERRNO_CODES) {
            if (ERRNO_CODES[key] === errno) {
              this.code = key;
              break;
            }
          }
#endif
        };
        this.setErrno(errno);
#if ASSERTIONS
        this.message = ERRNO_MESSAGES[errno];
#else
        this.message = 'FS error';
#endif

#if ASSERTIONS && !MINIMAL_RUNTIME
        // Try to get a maximally helpful stack trace. On Node.js, getting Error.stack
        // now ensures it shows what we want.
        if (this.stack) {
          // Define the stack property for Node.js 4, which otherwise errors on the next line.
          Object.defineProperty(this, "stack", { value: (new Error).stack, writable: true });
          this.stack = demangleAll(this.stack);
        }
#endif // ASSERTIONS
      };
      FS.ErrnoError.prototype = new Error();
      FS.ErrnoError.prototype.constructor = FS.ErrnoError;
      // Some errors may happen quite a bit, to avoid overhead we reuse them (and suffer a lack of stack info)
      [{{{ cDefs.ENOENT }}}].forEach((code) => {
        FS.genericErrors[code] = new FS.ErrnoError(code);
        FS.genericErrors[code].stack = '<generic error, no stack>';
      });
    },
    staticInit: () => {
      FS.ensureErrnoError();

      FS.nameTable = new Array(4096);

      FS.mount(MEMFS, {}, '/');

      FS.createDefaultDirectories();
      FS.createDefaultDevices();
      FS.createSpecialDirectories();

      FS.filesystems = {
        'MEMFS': MEMFS,
#if LibraryManager.has('library_idbfs.js')
        'IDBFS': IDBFS,
#endif
#if LibraryManager.has('library_nodefs.js')
        'NODEFS': NODEFS,
#endif
#if LibraryManager.has('library_workerfs.js')
        'WORKERFS': WORKERFS,
#endif
#if LibraryManager.has('library_proxyfs.js')
        'PROXYFS': PROXYFS,
#endif
      };
    },
    init: (input, output, error) => {
#if ASSERTIONS
      assert(!FS.init.initialized, 'FS.init was previously called. If you want to initialize later with custom parameters, remove any earlier calls (note that one is automatically added to the generated code)');
#endif
      FS.init.initialized = true;

      FS.ensureErrnoError();

      // Allow Module.stdin etc. to provide defaults, if none explicitly passed to us here
      Module['stdin'] = input || Module['stdin'];
      Module['stdout'] = output || Module['stdout'];
      Module['stderr'] = error || Module['stderr'];

      FS.createStandardStreams();
    },
    quit: () => {
      FS.init.initialized = false;
      // force-flush all streams, so we get musl std streams printed out
#if hasExportedSymbol('fflush')
      _fflush(0);
#endif
      // close all of our streams
      for (var i = 0; i < FS.streams.length; i++) {
        var stream = FS.streams[i];
        if (!stream) {
          continue;
        }
        FS.close(stream);
      }
    },

    //
    // old v1 compatibility functions
    //
    getMode: (canRead, canWrite) => {
      var mode = 0;
      if (canRead) mode |= {{{ cDefs.S_IRUGO }}} | {{{ cDefs.S_IXUGO }}};
      if (canWrite) mode |= {{{ cDefs.S_IWUGO }}};
      return mode;
    },
    findObject: (path, dontResolveLastLink) => {
      var ret = FS.analyzePath(path, dontResolveLastLink);
      if (!ret.exists) {
        return null;
      }
      return ret.object;
    },
    analyzePath: (path, dontResolveLastLink) => {
      // operate from within the context of the symlink's target
      try {
        var lookup = FS.lookupPath(path, { follow: !dontResolveLastLink });
        path = lookup.path;
      } catch (e) {
      }
      var ret = {
        isRoot: false, exists: false, error: 0, name: null, path: null, object: null,
        parentExists: false, parentPath: null, parentObject: null
      };
      try {
        var lookup = FS.lookupPath(path, { parent: true });
        ret.parentExists = true;
        ret.parentPath = lookup.path;
        ret.parentObject = lookup.node;
        ret.name = PATH.basename(path);
        lookup = FS.lookupPath(path, { follow: !dontResolveLastLink });
        ret.exists = true;
        ret.path = lookup.path;
        ret.object = lookup.node;
        ret.name = lookup.node.name;
        ret.isRoot = lookup.path === '/';
      } catch (e) {
        ret.error = e.errno;
      };
      return ret;
    },
    createPath: (parent, path, canRead, canWrite) => {
      parent = typeof parent == 'string' ? parent : FS.getPath(parent);
      var parts = path.split('/').reverse();
      while (parts.length) {
        var part = parts.pop();
        if (!part) continue;
        var current = PATH.join2(parent, part);
        try {
          FS.mkdir(current);
        } catch (e) {
          // ignore EEXIST
        }
        parent = current;
      }
      return current;
    },
    createFile: (parent, name, properties, canRead, canWrite) => {
      var path = PATH.join2(typeof parent == 'string' ? parent : FS.getPath(parent), name);
      var mode = FS.getMode(canRead, canWrite);
      return FS.create(path, mode);
    },
    createDataFile: (parent, name, data, canRead, canWrite, canOwn) => {
      var path = name;
      if (parent) {
        parent = typeof parent == 'string' ? parent : FS.getPath(parent);
        path = name ? PATH.join2(parent, name) : parent;
      }
      var mode = FS.getMode(canRead, canWrite);
      var node = FS.create(path, mode);
      if (data) {
        if (typeof data == 'string') {
          var arr = new Array(data.length);
          for (var i = 0, len = data.length; i < len; ++i) arr[i] = data.charCodeAt(i);
          data = arr;
        }
        // make sure we can write to the file
        FS.chmod(node, mode | {{{ cDefs.S_IWUGO }}});
        var stream = FS.open(node, {{{ cDefs.O_TRUNC | cDefs.O_CREAT | cDefs.O_WRONLY }}});
        FS.write(stream, data, 0, data.length, 0, canOwn);
        FS.close(stream);
        FS.chmod(node, mode);
      }
      return node;
    },
    createDevice: (parent, name, input, output) => {
      var path = PATH.join2(typeof parent == 'string' ? parent : FS.getPath(parent), name);
      var mode = FS.getMode(!!input, !!output);
      if (!FS.createDevice.major) FS.createDevice.major = 64;
      var dev = FS.makedev(FS.createDevice.major++, 0);
      // Create a fake device that a set of stream ops to emulate
      // the old behavior.
      FS.registerDevice(dev, {
        open: (stream) => {
          stream.seekable = false;
        },
        close: (stream) => {
          // flush any pending line data
          if (output && output.buffer && output.buffer.length) {
            output({{{ charCode('\n') }}});
          }
        },
        read: (stream, buffer, offset, length, pos /* ignored */) => {
          var bytesRead = 0;
          for (var i = 0; i < length; i++) {
            var result;
            try {
              result = input();
            } catch (e) {
              throw new FS.ErrnoError({{{ cDefs.EIO }}});
            }
            if (result === undefined && bytesRead === 0) {
              throw new FS.ErrnoError({{{ cDefs.EAGAIN }}});
            }
            if (result === null || result === undefined) break;
            bytesRead++;
            buffer[offset+i] = result;
          }
          if (bytesRead) {
            stream.node.timestamp = Date.now();
          }
          return bytesRead;
        },
        write: (stream, buffer, offset, length, pos) => {
          for (var i = 0; i < length; i++) {
            try {
              output(buffer[offset+i]);
            } catch (e) {
              throw new FS.ErrnoError({{{ cDefs.EIO }}});
            }
          }
          if (length) {
            stream.node.timestamp = Date.now();
          }
          return i;
        }
      });
      return FS.mkdev(path, mode, dev);
    },
    // Makes sure a file's contents are loaded. Returns whether the file has
    // been loaded successfully. No-op for files that have been loaded already.
    forceLoadFile: (obj) => {
      if (obj.isDevice || obj.isFolder || obj.link || obj.contents) return true;
      if (typeof XMLHttpRequest != 'undefined') {
        throw new Error("Lazy loading should have been performed (contents set) in createLazyFile, but it was not. Lazy loading only works in web workers. Use --embed-file or --preload-file in emcc on the main thread.");
      } else if (read_) {
        // Command-line.
        try {
          // WARNING: Can't read binary files in V8's d8 or tracemonkey's js, as
          //          read() will try to parse UTF8.
          obj.contents = intArrayFromString(read_(obj.url), true);
          obj.usedBytes = obj.contents.length;
        } catch (e) {
          throw new FS.ErrnoError({{{ cDefs.EIO }}});
        }
      } else {
        throw new Error('Cannot load without read() or XMLHttpRequest.');
      }
    },
    // Creates a file record for lazy-loading from a URL. XXX This requires a synchronous
    // XHR, which is not possible in browsers except in a web worker! Use preloading,
    // either --preload-file in emcc or FS.createPreloadedFile
    createLazyFile: (parent, name, url, canRead, canWrite) => {
      // Lazy chunked Uint8Array (implements get and length from Uint8Array). Actual getting is abstracted away for eventual reuse.
      /** @constructor */
      function LazyUint8Array() {
        this.lengthKnown = false;
        this.chunks = []; // Loaded chunks. Index is the chunk number
      }
      LazyUint8Array.prototype.get = /** @this{Object} */ function LazyUint8Array_get(idx) {
        if (idx > this.length-1 || idx < 0) {
          return undefined;
        }
        var chunkOffset = idx % this.chunkSize;
        var chunkNum = (idx / this.chunkSize)|0;
        return this.getter(chunkNum)[chunkOffset];
      };
      LazyUint8Array.prototype.setDataGetter = function LazyUint8Array_setDataGetter(getter) {
        this.getter = getter;
      };
      LazyUint8Array.prototype.cacheLength = function LazyUint8Array_cacheLength() {
        // Find length
        var xhr = new XMLHttpRequest();
        xhr.open('HEAD', url, false);
        xhr.send(null);
        if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
        var datalength = Number(xhr.getResponseHeader("Content-length"));
        var header;
        var hasByteServing = (header = xhr.getResponseHeader("Accept-Ranges")) && header === "bytes";
        var usesGzip = (header = xhr.getResponseHeader("Content-Encoding")) && header === "gzip";

#if SMALL_XHR_CHUNKS
        var chunkSize = 1024; // Chunk size in bytes
#else
        var chunkSize = 1024*1024; // Chunk size in bytes
#endif

        if (!hasByteServing) chunkSize = datalength;

        // Function to get a range from the remote URL.
        var doXHR = (from, to) => {
          if (from > to) throw new Error("invalid range (" + from + ", " + to + ") or no bytes requested!");
          if (to > datalength-1) throw new Error("only " + datalength + " bytes available! programmer error!");

          // TODO: Use mozResponseArrayBuffer, responseStream, etc. if available.
          var xhr = new XMLHttpRequest();
          xhr.open('GET', url, false);
          if (datalength !== chunkSize) xhr.setRequestHeader("Range", "bytes=" + from + "-" + to);

          // Some hints to the browser that we want binary data.
          xhr.responseType = 'arraybuffer';
          if (xhr.overrideMimeType) {
            xhr.overrideMimeType('text/plain; charset=x-user-defined');
          }

          xhr.send(null);
          if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
          if (xhr.response !== undefined) {
            return new Uint8Array(/** @type{Array<number>} */(xhr.response || []));
          }
          return intArrayFromString(xhr.responseText || '', true);
        };
        var lazyArray = this;
        lazyArray.setDataGetter((chunkNum) => {
          var start = chunkNum * chunkSize;
          var end = (chunkNum+1) * chunkSize - 1; // including this byte
          end = Math.min(end, datalength-1); // if datalength-1 is selected, this is the last block
          if (typeof lazyArray.chunks[chunkNum] == 'undefined') {
            lazyArray.chunks[chunkNum] = doXHR(start, end);
          }
          if (typeof lazyArray.chunks[chunkNum] == 'undefined') throw new Error('doXHR failed!');
          return lazyArray.chunks[chunkNum];
        });

        if (usesGzip || !datalength) {
          // if the server uses gzip or doesn't supply the length, we have to download the whole file to get the (uncompressed) length
          chunkSize = datalength = 1; // this will force getter(0)/doXHR do download the whole file
          datalength = this.getter(0).length;
          chunkSize = datalength;
          out("LazyFiles on gzip forces download of the whole file when length is accessed");
        }

        this._length = datalength;
        this._chunkSize = chunkSize;
        this.lengthKnown = true;
      };
      if (typeof XMLHttpRequest != 'undefined') {
        if (!ENVIRONMENT_IS_WORKER) throw 'Cannot do synchronous binary XHRs outside webworkers in modern browsers. Use --embed-file or --preload-file in emcc';
        var lazyArray = new LazyUint8Array();
        Object.defineProperties(lazyArray, {
          length: {
            get: /** @this{Object} */ function() {
              if (!this.lengthKnown) {
                this.cacheLength();
              }
              return this._length;
            }
          },
          chunkSize: {
            get: /** @this{Object} */ function() {
              if (!this.lengthKnown) {
                this.cacheLength();
              }
              return this._chunkSize;
            }
          }
        });

        var properties = { isDevice: false, contents: lazyArray };
      } else {
        var properties = { isDevice: false, url: url };
      }

      var node = FS.createFile(parent, name, properties, canRead, canWrite);
      // This is a total hack, but I want to get this lazy file code out of the
      // core of MEMFS. If we want to keep this lazy file concept I feel it should
      // be its own thin LAZYFS proxying calls to MEMFS.
      if (properties.contents) {
        node.contents = properties.contents;
      } else if (properties.url) {
        node.contents = null;
        node.url = properties.url;
      }
      // Add a function that defers querying the file size until it is asked the first time.
      Object.defineProperties(node, {
        usedBytes: {
          get: /** @this {FSNode} */ function() { return this.contents.length; }
        }
      });
      // override each stream op with one that tries to force load the lazy file first
      var stream_ops = {};
      var keys = Object.keys(node.stream_ops);
      keys.forEach((key) => {
        var fn = node.stream_ops[key];
        stream_ops[key] = function forceLoadLazyFile() {
          FS.forceLoadFile(node);
          return fn.apply(null, arguments);
        };
      });
      function writeChunks(stream, buffer, offset, length, position) {
        var contents = stream.node.contents;
        if (position >= contents.length)
          return 0;
        var size = Math.min(contents.length - position, length);
#if ASSERTIONS
        assert(size >= 0);
#endif
        if (contents.slice) { // normal array
          for (var i = 0; i < size; i++) {
            buffer[offset + i] = contents[position + i];
          }
        } else {
          for (var i = 0; i < size; i++) { // LazyUint8Array from sync binary XHR
            buffer[offset + i] = contents.get(position + i);
          }
        }
        return size;
      }
      // use a custom read function
      stream_ops.read = (stream, buffer, offset, length, position) => {
        FS.forceLoadFile(node);
        return writeChunks(stream, buffer, offset, length, position)
      };
      // use a custom mmap function
      stream_ops.mmap = (stream, length, position, prot, flags) => {
        FS.forceLoadFile(node);
        var ptr = mmapAlloc(length);
        if (!ptr) {
          throw new FS.ErrnoError({{{ cDefs.ENOMEM }}});
        }
        writeChunks(stream, HEAP8, ptr, length, position);
        return { ptr: ptr, allocated: true };
      };
      node.stream_ops = stream_ops;
      return node;
    },
    // Preloads a file asynchronously. You can call this before run, for example in
    // preRun. run will be delayed until this file arrives and is set up.
    // If you call it after run(), you may want to pause the main loop until it
    // completes, if so, you can use the onload parameter to be notified when
    // that happens.
    // In addition to normally creating the file, we also asynchronously preload
    // the browser-friendly versions of it: For an image, we preload an Image
    // element and for an audio, and Audio. These are necessary for SDL_Image
    // and _Mixer to find the files in preloadedImages/Audios.
    // You can also call this with a typed array instead of a url. It will then
    // do preloading for the Image/Audio part, as if the typed array were the
    // result of an XHR that you did manually.
    createPreloadedFile: (parent, name, url, canRead, canWrite, onload, onerror, dontCreateFile, canOwn, preFinish) => {
      // TODO we should allow people to just pass in a complete filename instead
      // of parent and name being that we just join them anyways
      var fullname = name ? PATH_FS.resolve(PATH.join2(parent, name)) : parent;
      var dep = getUniqueRunDependency('cp ' + fullname); // might have several active requests for the same fullname
      function processData(byteArray) {
        function finish(byteArray) {
          if (preFinish) preFinish();
          if (!dontCreateFile) {
            FS.createDataFile(parent, name, byteArray, canRead, canWrite, canOwn);
          }
          if (onload) onload();
          removeRunDependency(dep);
        }
        if (Browser.handledByPreloadPlugin(byteArray, fullname, finish, () => {
          if (onerror) onerror();
          removeRunDependency(dep);
        })) {
          return;
        }
        finish(byteArray);
      }
      addRunDependency(dep);
      if (typeof url == 'string') {
        asyncLoad(url, (byteArray) => processData(byteArray), onerror);
      } else {
        processData(url);
      }
    },

    // Removed v1 functions
#if ASSERTIONS
    absolutePath: () => {
      abort('FS.absolutePath has been removed; use PATH_FS.resolve instead');
    },
    createFolder: () => {
      abort('FS.createFolder has been removed; use FS.mkdir instead');
    },
    createLink: () => {
      abort('FS.createLink has been removed; use FS.symlink instead');
    },
    joinPath: () => {
      abort('FS.joinPath has been removed; use PATH.join instead');
    },
    mmapAlloc: () => {
      abort('FS.mmapAlloc has been replaced by the top level function mmapAlloc');
    },
    standardizePath: () => {
      abort('FS.standardizePath has been removed; use PATH.normalize instead');
    },
#endif
  },
});

if (FORCE_FILESYSTEM) {
  DEFAULT_LIBRARY_FUNCS_TO_INCLUDE.push('$FS');
}
