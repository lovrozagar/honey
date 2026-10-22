import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;

/** Reflection on the SDK's public surface: the one place the driver calls a method by its name. */
final class Reflect {
  private Reflect() {}

  /** The public instance method {@code name} of {@code type} taking {@code params} arguments. */
  static Method method(Class<?> type, String name, int params) {
    for (Method method : type.getMethods()) {
      if (method.getName().equals(name)
          && method.getParameterCount() == params
          && !Modifier.isStatic(method.getModifiers())) {
        return method;
      }
    }
    throw new DriverException(type.getSimpleName() + " has no method " + name);
  }

  /** {@code target.name(args)}; the SDK's own exception passes through unchanged. */
  static Object call(Object target, String name, Object... args) {
    Method method = method(target.getClass(), name, args.length);
    try {
      return method.invoke(target, args);
    } catch (InvocationTargetException e) {
      throw unwrap(e.getCause());
    } catch (IllegalAccessException e) {
      throw new DriverException(name + " is not accessible: " + e.getMessage());
    }
  }

  /** {@code type.name()}, a public static method with no arguments. */
  static Object invokeStatic(Class<?> type, String name) {
    try {
      return type.getMethod(name).invoke(null);
    } catch (ReflectiveOperationException e) {
      throw new DriverException(type.getSimpleName() + "." + name + " failed: " + e.getMessage());
    }
  }

  /**
   * The exception to throw for {@code cause}: a runtime one as it is, an error as it is, else
   * wrapped.
   */
  static RuntimeException unwrap(Throwable cause) {
    if (cause instanceof RuntimeException runtime) {
      return runtime;
    }
    if (cause instanceof Error error) {
      throw error;
    }
    return new DriverException(cause.toString());
  }
}
