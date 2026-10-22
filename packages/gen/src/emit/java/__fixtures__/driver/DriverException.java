/** A run the driver cannot express, or a script it refuses: exit 1 with its reason on stderr. */
final class DriverException extends RuntimeException {
  private static final long serialVersionUID = 1L;

  DriverException(String message) {
    super(message);
  }
}
